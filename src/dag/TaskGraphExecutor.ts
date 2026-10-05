import { taskTopology } from './taskTopology.js';
import { buildCallOptions, type AICallPolicy } from '../ai-runner/CallPolicy.js';
import { taskExecutionPrompt, conflictRepairPrompt } from '../prompts/taskExecution.js';
import { MAX_CONFLICT_REPAIR_CALLS, taskGraphRecursionLimit } from './limits.js';
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

/**
 * 任务图执行器依赖的外部能力。
 *
 * 这些依赖把“状态管理、AI 执行、Git 集成、工作树创建、重试恢复”分层解耦，
 * 让 TaskGraphExecutor 只负责协调任务图的调度和合并，而不直接耦合底层实现细节。
 */
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
  aiPolicy: AICallPolicy;
  rules?: string;
  install(workDir: string, signal?: AbortSignal): Promise<void>;
  onOutput?: Parameters<AIRunner['run']>[0]['onStreamEvent'];
  checkpoint?: (name: string, task: TaskRun) => Promise<void>;
}

/**
 * 任务图执行器。
 *
 * 它的职责不是只“执行一个任务”，而是把某个 issue 中的计划转换成一张依赖图，
 * 按照依赖顺序逐步执行，并在任务成功后合并回集成分支。
 *
 * 设计上分成两层：
 * - LangGraph 负责依赖调度与汇合，即哪些任务能执行、哪些任务必须等待前置任务
 * - 业务事务负责成功凭证、配套恢复和串行 Git 合并，确保状态一致且可恢复
 */
export class TaskGraphExecutor {
  private readonly mergeMutex = new AsyncMutex();
  private failure?: Error;
  private readonly execution: {
    planRevision: number;
    buildGeneration: number;
    dispatchId?: string;
    checkpointNamespace: string;
  };
  constructor(private readonly deps: GraphDependencies) {
    const run = deps.tracker.get(deps.number)!.run;
    this.execution = {
      planRevision: run.planRevision,
      buildGeneration: run.buildGeneration,
      dispatchId: run.dispatchId,
      // 任务图是一次构建阶段尝试的临时子图。外层 IssueWorkflow 会把嵌套图检查点
      // 持久化到同一个 Issue 线程；每次阶段重试必须使用新命名空间，否则 LangGraph
      // 会从上一次已结束的图恢复，直接跳过失败节点，最终只剩下“阻塞任务”。
      checkpointNamespace: `dag:${run.dispatchId ?? randomUUID()}:${run.phaseExecutions.build ?? 0}`,
    };
  }
  private state() {
    return this.deps.tracker.get(this.deps.number)!.run;
  }

  /**
   * 执行前统一安全检查：
   * - 任务图是否已失效（计划版本/构建版本/dispatchId 变了）
   * - 当前 issue 是否被停止
   * - 状态存储是否仍然可写
   *
   * 任何“旧任务图继续执行”都必须在这里被拦住。
   */
  private check(): void {
    this.deps.signal.throwIfAborted();
    const current = this.state();
    if (
      current.planRevision !== this.execution.planRevision ||
      current.buildGeneration !== this.execution.buildGeneration ||
      current.dispatchId !== this.execution.dispatchId
    )
      throw new Error('任务图调度身份已失效');
    if (current.stopIntent || this.deps.tracker.store.isBlocked(this.deps.number))
      throw new Error('Issue 已停止或状态存储不可写');
  }

  /**
   * 任务状态更新的受控入口。
   * 统一先执行 check，再在 tracker 事务里更新对应 task 的状态，防止并发写入破坏状态机。
   */
  private update(id: string, update: (task: TaskRun) => void): void {
    this.check();
    this.deps.tracker.transaction(this.deps.number, (record) => update(record.run.tasks[id]));
  }

  /**
   * 任务图总入口：
   * 1. 确认当前计划已审核通过且版本正确
   * 2. 读取计划并构造依赖图
   * 3. 先处理已有成功但未合并的任务，避免重复调用 AI
   * 4. 运行图中的所有任务节点
   * 5. 最终校验所有任务是否都已 merged
   */
  async execute(): Promise<void> {
    const { number, tracker } = this.deps;

    // 1. 确认当前执行仍对应一个已审核通过的计划，并读取计划的完整内容。
    const run = this.state();
    if (run.review?.decision !== 'approved' || run.review.revision !== run.planRevision)
      throw new Error('当前计划尚未审核通过');
    const plan = tracker.store.readPlan(number, run.planRevision, run.planDigest);

    // 2. 第一次执行时记录集成分支的初始提交，后续所有任务都以这个集成为基准。
    if (!run.integrationBase) {
      const base = await this.deps.integration.head();
      tracker.transaction(number, (record) => {
        record.run.integrationBase = base;
        record.run.integrationHead = base;
      });
    }

    // 3. 恢复已经执行成功但还没有完成合并的任务，避免普通重试再次调用 AI。
    for (const task of Object.values(this.state().tasks)) {
      if (task.status === 'merged') continue;
      if (task.success) await this.integrate(task.taskId);
    }

    // 4. 为批准后的任务计划创建 LangGraph 状态图；每个任务节点只负责调度对应的业务执行逻辑。
    const taskState = new StateSchema({ issueNumber: z.number() });
    const graph = new StateGraph(taskState).addNode(
      Object.fromEntries(
        plan.tasks.map((definition) => [
          definition.id,
          async () => {
            // 4.1 失败或取消后不再启动新的节点，先让已经在途的同一超步任务自然结束。
            if (this.failure || this.deps.signal.aborted) return {};
            try {
              // 4.2 节点真正开始执行前重新确认调度身份和 Issue 状态仍然有效。
              this.check();
              const task = this.state().tasks[definition.id];

              // 4.3 已经合并的任务直接跳过；恢复场景中的成功凭证则只执行合并，不重新调用 AI。
              if (task.status === 'merged') return {};
              if (!definition.dependsOn.every((id) => this.state().tasks[id].status === 'merged'))
                throw new Error('前置任务尚未确认合并');
              if (task.success)
                await this.mergeMutex.runExclusive(() => this.integrate(definition.id));
              else await this.executeTask(definition);
            } catch (error) {
              this.failure ??= error as Error;
            }
            return {};
          },
        ]),
      ),
    );

    // 5. 根据任务依赖关系连接 START、任务节点和 END，形成完整的 DAG。
    const topology = taskTopology(plan.tasks);
    for (const { sources, target } of topology.joins) {
      if (sources.length) graph.addEdge(sources, target);
      else graph.addEdge(START, target);
    }
    for (const leaf of topology.leaves) graph.addEdge(leaf, END);

    // 6. 执行任务图；节点内部的业务状态和成功凭证才是最终判断依据，不依赖 LangGraph 的返回值。
    await graph
      .compile()
      .invoke(
        { issueNumber: number },
        {
          recursionLimit: taskGraphRecursionLimit(plan.tasks.length),
          configurable: { checkpoint_ns: this.execution.checkpointNamespace },
        },
      );

    // 7. 汇总执行结果：优先抛出节点捕获的首个错误，再确认所有任务确实已经进入 merged 状态。
    if (this.failure) throw this.failure;
    this.check();
    if (Object.values(this.state().tasks).some((t) => t.status !== 'merged'))
      throw new Error('任务图存在无法执行的阻塞任务');
  }
  /**
   * 执行单个任务。
   *
   * 每个任务都会在自己的独立 Git worktree / branch 中运行，避免直接污染主仓库。
   * 成功后会留下 task.success 作为业务成功凭证，并尝试立刻进入 merge 流程。
   */
  private async executeTask(definition: TaskDefinition): Promise<void> {
    const { number, tracker, repository, repositoryMutex, signal } = this.deps;

    // 1. 任务开始前做最后安全检查，并为这个任务创建新的尝试编号。
    this.check();
    const attemptNo = this.state().tasks[definition.id].attemptNo + 1;

    // 2. 为这个任务创建独立工作区和分支，确保它不会污染主仓库或其他任务。
    const short = randomUUID().replaceAll('-', '').slice(0, 16);
    const workDir = path.resolve(this.deps.worktreeRoot, `t-${short}`);
    const branch = `iaf-task/${short}`;
    const startCommit = await this.deps.integration.head();
    this.check();

    // 3. 把任务启动状态写入 tracker，记录 workDir、branch、起点 commit，方便以后恢复。
    tracker.transaction(number, (record) => {
      Object.assign(record.run.tasks[definition.id], {
        attemptNo,
        workDir,
        branch,
        startCommit,
        status: 'running',
        success: undefined,
        merge: undefined,
        error: undefined,
      });
      record.run.workspaces ??= [];
      record.run.workspaces.push({
        directory: workDir,
        branch,
        taskId: definition.id,
        attemptNo,
        createdAt: new Date().toISOString(),
      });
    });
    try {
      // 4. 创建 task 专属 Git worktree；这里用 mutex 串行化，避免多个 task 同时对仓库做 worktree 操作。
      await repositoryMutex.runExclusive(async () => {
        this.check();
        await repository.worktreeAdd(workDir, branch, startCommit);
      }, signal);

      // 5. 进入任务目录，确保目录仍位于工作区内，随后装依赖。
      const cwd = path.resolve(workDir, this.deps.projectSubdir ?? '');
      if (!isInside(workDir, cwd, true)) throw new Error('项目子目录超出任务工作区');
      await this.deps.install(cwd, signal);

      // 6. 真正执行 AI 任务，注入当前需求、审批后的计划和当前任务定义作为 prompt。
      const runner = scopedRunner(
        this.deps.runner,
        tracker,
        number,
        signal,
        definition.id,
        attemptNo,
      );
      const result = await runner.run({
        workDir: cwd,
        ...buildCallOptions(this.deps.aiPolicy, 'task'),
        prompt: taskExecutionPrompt(
          tracker.store.readPlan(number, this.state().planRevision),
          definition,
          this.deps.rules,
        ),
        onStreamEvent: this.deps.onOutput,
      });

      // 7. 任务成功必须有业务凭证；如果没有 identity，说明这次运行没有有效产出。
      this.check();
      if (!result.success || !result.identity)
        throw new Error(result.errorMessage || '任务执行失败，未产生成功凭证');
      tracker.assertIdentity(result.identity);

      // 8. 把 AI 产出的结果落成一个提交候选，并检查是否真的改了内容。
      const git = new GitOperations(workDir, signal);
      const resultCommit = await git.commitCandidate(`feat: ${definition.title} (#${number})`);
      tracker.assertIdentity(result.identity);
      const noChange = !(await git.changedContent(startCommit, resultCommit));

      // 9. 写入业务成功凭证：成功 commit、变更状态、标记等待 merge。
      this.update(definition.id, (task) => {
        task.success = {
          identity: result.identity!,
          resultCommit,
          noChange,
          completedAt: new Date().toISOString(),
          sessionId: result.sessionId,
        };
        task.status = 'waiting-merge';
      });
      await this.deps.checkpoint?.('execution-saved', this.state().tasks[definition.id]);

      // 10. 成功后立即尝试集成到主分支；这里仍然用 mergeMutex 串行化，避免多个任务同时 merge 造成 Git 冲突。
      await this.mergeMutex.runExclusive(async () => {
        if (!this.failure && !signal.aborted) await this.integrate(definition.id);
      });
    } catch (error) {
      // 11. 失败时统一写到 this.failure，并把任务状态标记成 failed 或 waiting-merge，便于恢复时判断它是否已经有成功凭证。
      this.failure ??= error as Error;
      if (!signal.aborted && !tracker.store.isBlocked(number) && !this.state().stopIntent)
        this.update(definition.id, (task) => {
          task.status = task.success ? 'waiting-merge' : 'failed';
          task.error = (error as Error).message;
        });
      throw error;
    }
  }
  /**
   * 把某个已成功任务的提交整合到主集成分支。
   *
   * 流程大致是：
   * 1. 验证成功凭证
   * 2. 对任务提交执行 rebase，解决冲突
   * 3. rebase 完成后用 fast-forward merge 接回 integration
   * 4. 更新 task.status = merged，并写入 integrationHead
   */
  async integrate(id: string): Promise<void> {
    // 1. 合并前再次校验任务仍然有效，并确认这个任务是“已成功执行但尚未 merge”的状态。
    this.check();
    let task = this.state().tasks[id];
    if (!task.success || !task.workDir || !task.branch)
      throw new RecoveryError(`任务 ${id} 缺少服务端成功凭证`);

    // 2. 读取当前集成分支 HEAD，后续 rebase/merge 都基于这个位置做状态恢复和校验。
    const git = new GitOperations(task.workDir, this.deps.signal);
    let currentHead = await this.deps.integration.head();

    // 3. 如果任务已经等于 ready，说明上一次 rebase 已成功落盘；这里只需要确认它的记录完整且基线没被污染。
    if (task.merge?.stage === 'ready') {
      if (!task.merge.postRebaseCommit) throw new RecoveryError('缺少已落盘的变基结果');
      if (
        currentHead !== task.merge.integrationBefore &&
        currentHead !== task.merge.postRebaseCommit
      )
        throw new RecoveryError('集成分支发生无法解释的变化，请人工核对');
    } else {
      // 4. 如果上一次 rebase 中断，恢复到 rebase 前的状态，然后重新从原始基线继续。
      if (task.merge?.stage === 'rebasing') {
        if (currentHead !== task.merge.integrationBefore)
          throw new RecoveryError('恢复变基时集成起点不匹配');
        if (await git.isRebaseInProgress()) await git.rebaseAbort();
        await git.resetOwned(task.merge.preRebaseCommit);
      } else {
        // 5. 第一次进入 merge 时，需要确认集成分支没有未记录的外部提交，然后记录 merge 状态到 tracker。
        if (this.state().integrationHead && currentHead !== this.state().integrationHead)
          throw new RecoveryError('集成分支存在未记录的提交，请人工处理');
        this.update(id, (t) => {
          t.status = 'merging';
          t.merge = {
            operationId: randomUUID(),
            stage: 'rebasing',
            preRebaseCommit: t.success!.resultCommit,
            integrationBefore: currentHead,
          };
        });
      }

      // 6. 准备 rebase；如果任务无实际变更，可以直接跳过 rebase；否则执行 rebase 并在冲突时修复。
      await this.deps.checkpoint?.('before-rebase', this.state().tasks[id]);
      if (!task.success.noChange) {
        const rebased = await git.rebase(currentHead);
        if (!rebased.success) await this.deps.checkpoint?.('during-rebase', this.state().tasks[id]);
        let done = rebased.success;

        // 7. 冲突修复循环。每次冲突都让 AI 只修当前冲突文件，不改需求语义；最多两次，防止无限重试。
        while (!done) {
          this.check();
          task = this.state().tasks[id];
          if (task.conflictCallsUsed >= MAX_CONFLICT_REPAIR_CALLS)
            throw new RecoveryError(
              `任务 ${id} 的 ${MAX_CONFLICT_REPAIR_CALLS} 次冲突修复额度已用完`,
            );
          this.update(id, (t) => {
            t.conflictCallsUsed++;
          });
          const runner = scopedRunner(
            this.deps.runner,
            this.deps.tracker,
            this.deps.number,
            this.deps.signal,
            id,
            task.attemptNo,
          );
          const result = await runner.run({
            workDir: path.resolve(task.workDir!, this.deps.projectSubdir ?? ''),
            ...buildCallOptions(this.deps.aiPolicy, 'conflict-repair'),
            prompt: conflictRepairPrompt(
              this.deps.tracker.store.readPlan(this.deps.number, this.state().planRevision),
              await git.getConflictFiles(),
            ),
            onStreamEvent: this.deps.onOutput,
          });
          this.check();
          if (!result.success) throw new Error(result.errorMessage || '冲突修复执行失败');
          const continued = await git.rebaseContinue();
          done = continued.done;
        }
      }
      // 8. rebase 完成后，记录 postRebaseCommit，并把状态转成 ready，表示已准备好进行 fast-forward merge。
      await this.deps.checkpoint?.('after-rebase-before-save', this.state().tasks[id]);
      const postRebaseCommit = task.success!.noChange ? currentHead : await git.head();
      this.update(id, (t) => {
        t.merge!.postRebaseCommit = postRebaseCommit;
        t.merge!.stage = 'ready';
      });
    }

    // 9. 执行 fast-forward merge，把 rebase 后的提交直接接回 integration HEAD。
    task = this.state().tasks[id];
    this.check();
    currentHead = await this.deps.integration.head();
    if (currentHead === task.merge!.integrationBefore)
      await this.deps.integration.mergeFF(task.merge!.postRebaseCommit!);
    await this.deps.checkpoint?.('after-merge-before-save', task);

    // 10. 最后做幂等校验，确认真实 git HEAD 与记录的 postRebaseCommit 一致，再写任务状态为 merged。
    this.check();
    const after = await this.deps.integration.head();
    if (after !== task.merge!.postRebaseCommit)
      throw new RecoveryError('快进合并结果与已记录提交不一致');
    this.deps.tracker.transaction(this.deps.number, (record) => {
      const t = record.run.tasks[id];
      t.merge!.integrationAfter = after;
      t.merge!.stage = 'merged';
      t.status = 'merged';
      record.run.integrationHead = after;
    });
  }
}

/**
 * 路径安全检查：确保 target 位于 root 目录之内，避免 task 访问到工作区外的路径。
 */
export function isInside(root: string, target: string, allowRoot = false): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (allowRoot || !!relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}
export function assertOwnedDirectory(root: string, target: string): void {
  if (
    !isInside(root, target) ||
    (fs.existsSync(target) && !isInside(fs.realpathSync(root), fs.realpathSync(target)))
  )
    throw new Error(`工作目录不在配置根目录内：${target}`);
}
