import { RecoveryError } from './RecoveryError.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GitOperations } from '../git/GitOperations.js';
import { AsyncMutex } from '../utils/AsyncMutex.js';
import type { AIRunner } from '../ai-runner/AIRunner.js';
import type { IssueTracker } from '../tracker/IssueTracker.js';
import type { TaskDefinition, TaskRun } from './contracts.js';
import { scopedRunner } from './ScopedRunner.js';
import { END, START, StateGraph, StateSchema } from '@langchain/langgraph';
import { z } from 'zod';

export interface GraphDependencies {
  number: number;
  tracker: IssueTracker;
  runner: AIRunner;
  integration: GitOperations;
  repository: GitOperations;
  repositoryMutex: AsyncMutex;
  worktreeRoot: string;
  projectSubdir?: string;
  signal: AbortSignal;
  timeoutMs: number;
  rules?: string;
  install(workDir: string, signal?: AbortSignal): Promise<void>;
  onOutput?: Parameters<AIRunner['run']>[0]['onStreamEvent'];
  checkpoint?: (name: string, task: TaskRun) => Promise<void>;
}

/** LangGraph 负责依赖调度与汇合；任务成功凭证和串行 Git 合并仍由业务事务管理。 */
export class TaskGraphExecutor {
  private readonly mergeMutex = new AsyncMutex();
  private failure?: Error;
  private readonly execution: { planRevision: number; buildGeneration: number; dispatchId?: string };
  constructor(private readonly deps: GraphDependencies) {
    const run = deps.tracker.get(deps.number)!.run!;
    this.execution = { planRevision: run.planRevision, buildGeneration: run.buildGeneration, dispatchId: run.dispatchId };
  }
  private state() { return this.deps.tracker.get(this.deps.number)!.run!; }
  private check(): void {
    this.deps.signal.throwIfAborted();
    const current = this.state();
    if (current.planRevision !== this.execution.planRevision || current.buildGeneration !== this.execution.buildGeneration || current.dispatchId !== this.execution.dispatchId) throw new Error('任务图调度身份已失效');
    if (this.state().stopIntent || this.deps.tracker.store.isBlocked(this.deps.number)) throw new Error('Issue 已停止或状态存储不可写');
  }
  private update(id: string, update: (task: TaskRun) => void): void {
    this.check();
    this.deps.tracker.transaction(this.deps.number, record => update(record.run!.tasks[id]));
  }
  async execute(): Promise<void> {
    const { number, tracker } = this.deps;
    const run = this.state();
    if (run.review?.decision !== 'approved' || run.review.revision !== run.planRevision) throw new Error('当前计划尚未审核通过');
    const plan = tracker.store.readPlan(number, run.planRevision, run.planDigest);
    if (!run.integrationBase) {
      const base = await this.deps.integration.head();
      tracker.transaction(number, record => { record.run!.integrationBase = base; record.run!.integrationHead = base; });
    }
    // 普通重试先处理已有成功凭证，不能把成功任务作为未知任务重新调用 AI。
    for (const task of Object.values(this.state().tasks)) {
      if (task.status === 'merged') continue;
      if (task.success) await this.integrate(task.taskId);
    }
    const taskState = new StateSchema({ issueNumber: z.number() });
    const graph = new StateGraph(taskState).addNode(Object.fromEntries(plan.tasks.map(definition => [definition.id, async () => {
      // 不向框架抛出首个任务错误，先收齐同一超步的在途调用；失败后不派发下游任务。
      if (this.failure || this.deps.signal.aborted) return {};
      try {
        this.check();
        const task = this.state().tasks[definition.id];
        if (task.status === 'merged') return {};
        if (!definition.dependsOn.every(id => this.state().tasks[id].status === 'merged')) throw new Error('前置任务尚未确认合并');
        if (task.success) await this.mergeMutex.runExclusive(() => this.integrate(definition.id));
        else await this.executeTask(definition);
      } catch (error) { this.failure ??= error as Error; }
      return {};
    }])));
    const predecessors = new Set(plan.tasks.flatMap(task => task.dependsOn));
    for (const definition of plan.tasks) {
      if (definition.dependsOn.length) graph.addEdge(definition.dependsOn, definition.id);
      else graph.addEdge(START, definition.id);
      if (!predecessors.has(definition.id)) graph.addEdge(definition.id, END);
    }
    // 显式保留业务成功凭证检查。恢复后即使重入子图，也不会重新执行已合并的任务。
    await graph.compile().invoke({ issueNumber: number }, { recursionLimit: plan.tasks.length + 2 });
    if (this.failure) throw this.failure;
    this.check();
    if (Object.values(this.state().tasks).some(t => t.status !== 'merged')) throw new Error('任务图存在无法执行的阻塞任务');
  }
  private async executeTask(definition: TaskDefinition): Promise<void> {
    const { number, tracker, repository, repositoryMutex, signal } = this.deps;
    this.check();
    const attemptNo = this.state().tasks[definition.id].attemptNo + 1;
    const short = randomUUID().replaceAll('-', '').slice(0, 16);
    const workDir = path.resolve(this.deps.worktreeRoot, `t-${short}`);
    const branch = `iaf-task/${short}`;
    const startCommit = await this.deps.integration.head();
    this.check();
    tracker.transaction(number, record => {
      Object.assign(record.run!.tasks[definition.id], { attemptNo, workDir, branch, startCommit, status: 'running', success: undefined, merge: undefined, error: undefined });
      record.run!.workspaces ??= [];
      record.run!.workspaces.push({ directory: workDir, branch, taskId: definition.id, attemptNo, createdAt: new Date().toISOString() });
    });
    try {
      await repositoryMutex.runExclusive(async () => { this.check(); await repository.worktreeAdd(workDir, branch, startCommit); }, signal);
      const cwd = path.resolve(workDir, this.deps.projectSubdir ?? '');
      if (!isInside(workDir, cwd, true)) throw new Error('项目子目录超出任务工作区');
      await this.deps.install(cwd, signal);
      const runner = scopedRunner(this.deps.runner, tracker, number, signal, definition.id, attemptNo);
      const result = await runner.run({
        workDir: cwd, timeoutMs: this.deps.timeoutMs, mode: 'agent', phaseName: 'build',
        prompt: `${this.deps.rules ?? ''}\n实现当前父需求的一个内部任务。工作区已包含所有前置任务的已合并结果。不要推送代码、创建 PR 或修改 Git 分支；不写工作台运行产物。\n父需求与批准计划：\n${JSON.stringify(tracker.store.readPlan(number, this.state().planRevision))}\n当前任务：\n${JSON.stringify(definition)}`,
        onStreamEvent: this.deps.onOutput,
      });
      this.check();
      if (!result.success || !result.identity) throw new Error(result.errorMessage || '任务执行失败，未产生成功凭证');
      tracker.assertIdentity(result.identity);
      const git = new GitOperations(workDir, signal);
      const resultCommit = await git.commitCandidate(`feat: ${definition.title} (#${number})`);
      tracker.assertIdentity(result.identity);
      const noChange = !(await git.changedContent(startCommit, resultCommit));
      this.update(definition.id, task => {
        task.success = { identity: result.identity!, resultCommit, noChange, completedAt: new Date().toISOString(), sessionId: result.sessionId };
        task.status = 'waiting-merge';
      });
      await this.deps.checkpoint?.('execution-saved', this.state().tasks[definition.id]);
      await this.mergeMutex.runExclusive(async () => {
        if (!this.failure && !signal.aborted) await this.integrate(definition.id);
      });
    } catch (error) {
      this.failure ??= error as Error;
      if (!signal.aborted && !tracker.store.isBlocked(number) && !this.state().stopIntent) this.update(definition.id, task => {
        task.status = task.success ? 'waiting-merge' : 'failed';
        task.error = (error as Error).message;
      });
      throw error;
    }
  }
  async integrate(id: string): Promise<void> {
    this.check();
    let task = this.state().tasks[id];
    if (!task.success || !task.workDir || !task.branch) throw new RecoveryError(`任务 ${id} 缺少服务端成功凭证`);
    const git = new GitOperations(task.workDir, this.deps.signal);
    let currentHead = await this.deps.integration.head();
    if (task.merge?.stage === 'ready') {
      if (!task.merge.postRebaseCommit) throw new RecoveryError('缺少已落盘的变基结果');
      if (currentHead !== task.merge.integrationBefore && currentHead !== task.merge.postRebaseCommit) throw new RecoveryError('集成分支发生无法解释的变化，请人工核对');
    } else {
      if (task.merge?.stage === 'rebasing') {
        if (currentHead !== task.merge.integrationBefore) throw new RecoveryError('恢复变基时集成起点不匹配');
        if (await git.isRebaseInProgress()) await git.rebaseAbort();
        await git.resetOwned(task.merge.preRebaseCommit);
      } else {
        if (this.state().integrationHead && currentHead !== this.state().integrationHead) throw new RecoveryError('集成分支存在未记录的提交，请人工处理');
        this.update(id, t => {
          t.status = 'merging';
          t.merge = { operationId: randomUUID(), stage: 'rebasing', preRebaseCommit: t.success!.resultCommit, integrationBefore: currentHead };
        });
      }
      await this.deps.checkpoint?.('before-rebase', this.state().tasks[id]);
      if (!task.success.noChange) {
        const rebased = await git.rebase(currentHead);
        if (!rebased.success) await this.deps.checkpoint?.('during-rebase', this.state().tasks[id]);
        let done = rebased.success;
        while (!done) {
          this.check();
          task = this.state().tasks[id];
          if (task.conflictCallsUsed >= 2) throw new RecoveryError(`任务 ${id} 的两次冲突修复额度已用完`);
          this.update(id, t => { t.conflictCallsUsed++; });
          const runner = scopedRunner(this.deps.runner, this.deps.tracker, this.deps.number, this.deps.signal, id, task.attemptNo);
          const result = await runner.run({ workDir: path.resolve(task.workDir!, this.deps.projectSubdir ?? ''), mode: 'agent', phaseName: 'build', timeoutMs: this.deps.timeoutMs, prompt: `只修复当前 rebase 的冲突文件并暂存，不运行 rebase --continue，不提交或推送。保持已批准需求语义。冲突文件：${(await git.getConflictFiles()).join(', ')}`, onStreamEvent: this.deps.onOutput });
          this.check();
          if (!result.success) throw new Error(result.errorMessage || '冲突修复执行失败');
          const continued = await git.rebaseContinue();
          done = continued.done;
        }
      }
      await this.deps.checkpoint?.('after-rebase-before-save', this.state().tasks[id]);
      const postRebaseCommit = task.success!.noChange ? currentHead : await git.head();
      this.update(id, t => { t.merge!.postRebaseCommit = postRebaseCommit; t.merge!.stage = 'ready'; });
    }
    task = this.state().tasks[id];
    this.check();
    currentHead = await this.deps.integration.head();
    if (currentHead === task.merge!.integrationBefore) await this.deps.integration.mergeFF(task.merge!.postRebaseCommit!);
    await this.deps.checkpoint?.('after-merge-before-save', task);
    this.check();
    const after = await this.deps.integration.head();
    if (after !== task.merge!.postRebaseCommit) throw new RecoveryError('快进合并结果与已记录提交不一致');
    this.deps.tracker.transaction(this.deps.number, record => { const t = record.run!.tasks[id]; t.merge!.integrationAfter = after; t.merge!.stage = 'merged'; t.status = 'merged'; record.run!.integrationHead = after; });
  }
}

export function isInside(root: string, target: string, allowRoot = false): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (allowRoot || !!relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}
export function assertOwnedDirectory(root: string, target: string): void {
  if (!isInside(root, target) || (fs.existsSync(target) && !isInside(fs.realpathSync(root), fs.realpathSync(target)))) throw new Error(`工作目录不在配置根目录内：${target}`);
}
