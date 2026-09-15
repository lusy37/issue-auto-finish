import { isE2eEnabledForIssue } from '../e2e/E2eSettings.js';
import { RecoveryError } from '../dag/RecoveryError.js';
import { resolvePromptRules } from '../knowledge/PromptRules.js';
import { getKnowledgeForPrompt } from '../prompts/templates.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PhaseResult, PhaseSpec, PhaseRunnerContext } from '../orchestration/index.js';
import type { PhaseContext } from '../phases/BasePhase.js';
import type { OrchestratorDeps } from './IssueProcessingContext.js';
import { GitOperations } from '../git/GitOperations.js';
import { PlanPersistence } from '../persistence/PlanPersistence.js';
import { createPhase } from '../phases/PhaseFactory.js';
import { scopedRunner } from '../dag/ScopedRunner.js';
import { TaskGraphExecutor } from '../dag/TaskGraphExecutor.js';
import { validatePlan, renderPlan } from '../dag/contracts.js';

/** 外层阶段适配：DAG 限定在 build，verify/UAT 的凭证绑定实际候选提交。 */
export class DagPhaseRunner {
  constructor(private deps: OrchestratorDeps, private git: GitOperations, private plan: PlanPersistence) {}
  async run(spec: PhaseSpec, context: PhaseRunnerContext): Promise<PhaseResult> {
    const { tracker, config } = this.deps;
    const number = context.issueIid;
    const signal = this.deps.signal ?? new AbortController().signal;
    const runner = scopedRunner(this.deps.aiRunner, tracker, number, signal, `$phase:${spec.id}`);
    const state = () => tracker.get(number)!.run!;
    const callbacks = { onStreamEvent: (event: Parameters<NonNullable<Parameters<typeof runner.run>[0]['onStreamEvent']>>[0]) => this.deps.eventBus.emitTyped('agent:output', { issueIid: number, phase: spec.id, event }) };
    const ctx: PhaseContext = { demand: context.demand as PhaseContext['demand'], workDir: context.workDir, branchName: context.branchName, ports: context.ports as PhaseContext['ports'] };
    ctx.onTemporaryFile = (file, present) => tracker.transaction(number, record => {
      record.run!.temporaryFiles = [...new Set([...(record.run!.temporaryFiles ?? []).filter(existing => existing !== file), ...(present ? [file] : [])])];
    });
    if (spec.kind === 'gate') throw new Error('审核必须由 LangGraph interrupt 执行');
    try {
      signal.throwIfAborted();
      if (spec.id === 'build') {
        const rules = [resolvePromptRules(config.knowledge.enabled), JSON.stringify(getKnowledgeForPrompt(config.knowledge.enabled))].filter(Boolean).join('\n');
        if (state().buildEntry === 'repair-integration') {
          const repair = state().repairs.at(-1);
          if (!repair) throw new Error('缺少已持久化的集成修复报告');
          const before = await this.git.head();
          tracker.transaction(number, record => { record.run!.repairs.at(-1)!.before = before; });
          const result = await runner.run({ workDir: context.workDir, mode: 'agent', phaseName: 'build', timeoutMs: config.ai.phaseTimeoutMs, prompt: `${rules}\n按已批准的计划修复集成代码。不要重跑任务图，不要推送或创建 PR。\n计划：${JSON.stringify(tracker.store.readPlan(number, state().planRevision))}\n本轮验证失败报告：${repair.report}`, ...callbacks });
          if (!result.success) return { kind: 'failed', error: { message: result.errorMessage || '集成修复失败', retryable: 'hard' } };
          if (result.identity) tracker.assertIdentity(result.identity);
          const after = await this.git.commitCandidate(`fix: 集成验收修复 #${number} 第 ${repair.round} 轮`);
          tracker.transaction(number, record => { Object.assign(record.run!.repairs.at(-1)!, { after, identity: result.identity }); });
        } else {
          await new TaskGraphExecutor({ number, tracker, runner: this.deps.aiRunner, integration: this.git,
            repository: new GitOperations(config.project.gitRootDir, signal), repositoryMutex: this.deps.mainGitMutex,
            worktreeRoot: config.project.worktreeBaseDir, projectSubdir: config.project.projectSubDir,
            signal, rules, timeoutMs: config.ai.phaseTimeoutMs, install: (cwd, cancel) => this.deps.installDependencies(cwd, cancel), onOutput: callbacks.onStreamEvent,
          }).execute();
        }
        signal.throwIfAborted();
        if (isE2eEnabledForIssue(number, tracker, config) && !fs.existsSync(path.resolve(context.workDir, config.e2e.configFile))) {
          const prepared = await runner.run({ workDir: context.workDir, mode: 'agent', phaseName: 'build', timeoutMs: config.ai.phaseTimeoutMs,
            prompt: `为批准的需求补充 Playwright Chromium 验收测试和配置 ${config.e2e.configFile}。使用 process.env.UAT_BASE_URL 读取预览地址。不要运行验收，不写验收结论，不推送。需求：${JSON.stringify(ctx.demand)}`, ...callbacks });
          if (!prepared.success) return { kind: 'failed', error: { message: prepared.errorMessage || '浏览器测试准备失败', retryable: 'hard' } };
        }
        const lockHash = createHash('sha256');
        for (const file of ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
          const filename = path.join(context.workDir, file);
          if (fs.existsSync(filename)) lockHash.update(file).update(fs.readFileSync(filename));
        }
        const digest = lockHash.digest('hex');
        if (state().installedLockDigest !== digest) {
          await this.deps.installDependencies(context.workDir, signal, true);
          tracker.transaction(number, record => { record.run!.installedLockDigest = digest; });
        }
        signal.throwIfAborted();
        const commit = await this.git.commitCandidate(`chore: 完成 Issue #${number} 构建准备`);
        if (!state().integrationBase || !(await this.git.changedContent(state().integrationBase!, commit))) return { kind: 'failed', error: { message: '整批任务没有有效仓库内容变化，请人工核对需求，无需创建 PR', retryable: 'hard-no-auto' } };
        if (await this.git.hasChanges()) throw new Error('构建后仍存在未纳入候选提交的文件');
        tracker.transaction(number, record => { record.run!.candidateCommit = commit; record.run!.verify = undefined; record.run!.uat = undefined; });
        return { kind: 'completed', output: '任务图已汇总，候选提交已准备' };
      }
      const candidate = spec.id === 'plan' ? undefined : state().candidateCommit;
      if (spec.id !== 'plan') {
        if (!candidate || (await this.git.head()) !== candidate || await this.git.hasChanges()) throw new Error('候选提交或工作目录已改变，不能接受验证结果');
        if (Object.values(state().tasks).some(task => task.status !== 'merged')) throw new Error('仍有未完成的内部任务');
        if (spec.id === 'uat' && state().verify?.commit !== candidate) throw new Error('缺少当前候选提交的验证凭证');
      }
      const phase = createPhase(spec.id, runner, this.git, this.plan, config);
      const intent = await phase.run(ctx, callbacks);
      signal.throwIfAborted();
      if (intent.kind === 'requestRetryFrom' && state().repairRounds >= config.verifyFixLoop.maxIterations) return { kind: 'failed', error: { message: '集成自动修复额度已用完，请人工处理', retryable: 'hard-no-auto' } };
      if (spec.id === 'plan' && intent.kind === 'completed') {
        const content = validatePlan(JSON.parse(intent.output?.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? intent.output ?? ''));
        const plan = tracker.store.savePlan(number, content, state().version);
        this.plan.writePlan(renderPlan(plan));
      }
      if (candidate) {
        if ((await this.git.head()) !== candidate || await this.git.hasChanges()) throw new Error('检查过程中代码发生变化，该次验收结果无效');
        if (intent.kind === 'completed') {
          const reportPath = path.join(this.plan.planDir, spec.id === 'verify' ? '02-verify-report.md' : '03-uat-report.md');
          const runId = spec.id === 'uat' ? JSON.parse(this.plan.readFile('uat-run.json') ?? '{}').runId as string | undefined : undefined;
          tracker.transaction(number, record => {
            const receipt = { commit: candidate, passed: true as const, completedAt: new Date().toISOString(), reportPath, runId };
            if (spec.id === 'verify') record.run!.verify = receipt;
            else { record.run!.uat = receipt; record.uatRunId = runId; }
          });
        }
      }
      return intent;
    } catch (error) {
      if (signal.aborted || tracker.store.isBlocked(number)) throw error;
      return { kind: 'failed', error: { message: (error as Error).message, retryable: spec.id === 'build' && !(error instanceof RecoveryError) ? 'hard' : 'hard-no-auto' } };
    }
  }
}
