import { phaseCallId } from '../orchestration/ExecutionIds.js';
import { buildCallOptions, configuredCallPolicy } from '../ai-runner/CallPolicy.js';
import { integrationRepairPrompt, visualRepairPrompt } from '../prompts/taskExecution.js';
import { prepareUat, UatPreparationError } from '../e2e/UatPreparation.js';
import {
  parseVisualRepairDecision,
  VISUAL_REPAIR_OUTPUT_SCHEMA,
} from '../e2e/VisualReviewContract.js';
import { ARTIFACTS } from '../shared/runtime/artifacts.js';
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
import { renderPlan } from '../dag/contracts.js';
import { UatResultStore } from '../e2e/UatResultStore.js';
import { passedPlaywrightTests } from '../e2e/PlaywrightReportCodec.js';
import type { StreamEvent } from '../ai-runner/AIRunner.js';
import type { VisualRepairContext, VisualRepairDecision } from '../shared/workbench.js';
import type { VisualRepairDecisionPayload } from '../e2e/VisualReviewContract.js';

function validateVisualRepairDecision(
  decision: VisualRepairDecisionPayload,
  context: VisualRepairContext,
  workDir: string,
  before: string,
  plan: { revision: number; digest: string },
  dataDir: string,
): asserts decision is VisualRepairDecision {
  const gapIndex = context.gap.gapIndex;
  if (decision.sourceRunId !== context.sourceRunId) throw new Error('sourceRunId 不匹配');
  if (decision.candidateCommit !== context.candidateCommit || decision.candidateCommit !== before)
    throw new Error('candidateCommit 不匹配');
  if (decision.planRevision !== context.planRevision || decision.planRevision !== plan.revision)
    throw new Error('planRevision 不匹配');
  if (decision.planDigest !== context.planDigest || decision.planDigest !== plan.digest)
    throw new Error('planDigest 不匹配');
  if (decision.buildGeneration !== context.buildGeneration) throw new Error('buildGeneration 不匹配');
  if (gapIndex === undefined || decision.gapIndex !== gapIndex) throw new Error('gapIndex 不匹配');

  const reportDigest = createHash('sha256').update(context.report).digest('hex');
  const requiredRefs = new Set(context.gap.acceptanceRefs);
  const coveredRefs = new Set(decision.testRefs.flatMap((ref) => ref.acceptanceRefs));
  if (decision.decision === 'behavior-covered' && (requiredRefs.size === 0 || decision.testRefs.length === 0 || [...requiredRefs].some((ref) => !coveredRefs.has(ref))))
    throw new Error('behavior-covered 必须引用覆盖全部验收条目的通过测试');
  if (decision.decision === 'behavior-covered' && context.gap.kind !== 'missing-visible-state')
    throw new Error('只有明确的可见状态缺口可以被行为测试异议覆盖');
  if (decision.decision === 'behavior-covered' && decision.changedFiles.length)
    throw new Error('behavior-covered 的 changedFiles 必须为空');
  const passedTests = decision.testRefs.length
    ? passedPlaywrightTests(JSON.parse(fs.readFileSync(
      path.join(dataDir, 'uat', context.sourceRunId, 'results.json'), 'utf8',
    )))
    : new Set<string>();
  const sources = new Map<string, { content: string; lines: string[] }>();
  for (const ref of decision.testRefs) {
    if (ref.reportDigest !== reportDigest) throw new Error(`测试引用 ${ref.testId} 不属于当前 Playwright 报告`);
    const absolute = path.resolve(workDir, ref.path);
    const relative = path.relative(path.resolve(workDir), absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(absolute))
      throw new Error(`测试引用路径无效：${ref.path}`);
    let source = sources.get(absolute);
    if (!source) {
      const content = fs.readFileSync(absolute, 'utf8');
      source = { content, lines: content.split(/\r?\n/) };
      sources.set(absolute, source);
    }
    if (!source.lines[ref.line - 1])
      throw new Error(`测试引用行号无效：${ref.path}:${ref.line}`);
    if (!source.content.includes(ref.testId))
      throw new Error(`测试文件中找不到测试 ID：${ref.testId}`);
    if (!passedTests.has(ref.testId))
      throw new Error(`本轮 Playwright 报告没有确认测试通过：${ref.testId}`);
  }
}

/**
 * DAG 阶段执行适配器。
 *
 * 设计意图：
 * 1. `build` 阶段负责生成候选提交，并通过任务图 / 修复路径推进代码落地；
 * 2. `verify` / `uat` 阶段只接受已确定的候选提交结果，避免在脏工作区或过期状态上做认证；
 * 3. 所有阶段都统一记录产物、报告和修复凭证，便于后续审计和复盘。
 */
export class DagPhaseRunner {
  constructor(
    private deps: OrchestratorDeps,
    private git: GitOperations,
    private plan: PlanPersistence,
  ) {}

  /**
   * 统一入口：根据 phase 类型选择执行分支。
   *
   * 关键约束：
   * - `build` 负责任务图执行与候选提交生成；
   * - `plan` 只保存结构化计划；
   * - `verify` / `uat` 必须绑定候选提交并校验仓库稳定性；
   * - 最终都会返回统一的 `PhaseResult`。
   */
  async run(spec: PhaseSpec, context: PhaseRunnerContext): Promise<PhaseResult> {
    // --- 1. 入参与运行时上下文准备 ---
    const { tracker, config } = this.deps;
    const number = context.issueIid;
    const signal = this.deps.signal ?? new AbortController().signal;
    const runner = scopedRunner(this.deps.aiRunner, tracker, number, signal, phaseCallId(spec.id));
    const state = () => tracker.get(number)!.run;
    const callbacks = {
      onStreamEvent: (event: StreamEvent) =>
        this.deps.eventBus.emitTyped('agent:output', { issueIid: number, phase: spec.id, event }),
    };
    const ctx: PhaseContext = {
      demand: context.demand as PhaseContext['demand'],
      workDir: context.workDir,
      branchName: context.branchName,
      ports: context.ports as PhaseContext['ports'],
    };
    ctx.onTemporaryFile = (file, present) =>
      tracker.transaction(number, (record) => {
        record.run.temporaryFiles = [
          ...new Set([
            ...(record.run.temporaryFiles ?? []).filter((existing) => existing !== file),
            ...(present ? [file] : []),
          ]),
        ];
      });
    if (spec.kind === 'gate') throw new Error('审核必须由 LangGraph interrupt 执行');

    try {
      signal.throwIfAborted();

      // --- 2. 构建阶段：确保候选提交与修复能力被正确应用 ---
      if (spec.id === 'build') {
        let visualDecision: VisualRepairDecision | undefined;
        const rules = [
          resolvePromptRules(config.knowledge.enabled),
          JSON.stringify(getKnowledgeForPrompt(config.knowledge.enabled)),
        ]
          .filter(Boolean)
          .join('\n');

        // 2.1 集成修复回流：在失败的构建路径上继续修正，而不是直接丢弃
        if (state().buildEntry === 'repair-integration') {
          const repair = state().repairs.at(-1);
          if (!repair) throw new Error('缺少已持久化的集成修复报告');
          const before = await this.git.head();
          if (repair.visual && before !== repair.visual.candidateCommit)
            throw new Error('视觉修复上下文与当前候选提交不一致');
          tracker.transaction(number, (record) => {
            record.run.repairs.at(-1)!.before = before;
          });
          const plan = tracker.store.readPlan(number, state().planRevision, state().planDigest);
          const result = await runner.run({
            workDir: context.workDir,
            ...buildCallOptions(configuredCallPolicy(config.ai), 'integration-repair'),
            prompt: repair.visual
              ? visualRepairPrompt(plan, repair.visual, rules)
              : integrationRepairPrompt(plan, repair.report, rules),
            ...(repair.visual ? { outputSchema: VISUAL_REPAIR_OUTPUT_SCHEMA } : {}),
            ...callbacks,
          });
          if (!result.success)
            return {
              kind: 'failed',
              error: { message: result.errorMessage || '集成修复失败', retryable: 'hard' },
            };
          if (result.identity) tracker.assertIdentity(result.identity);
          if (repair.visual) {
            try {
              const parsed = parseVisualRepairDecision(result.output);
              validateVisualRepairDecision(
                parsed,
                repair.visual,
                context.workDir,
                before,
                plan,
                this.plan.dataDirectory,
              );
              visualDecision = parsed;
            } catch (error) {
              return {
                kind: 'failed',
                error: { message: `视觉修复决定无效：${(error as Error).message}`, retryable: 'hard-no-auto', rawOutput: result.output },
              };
            }
          }
          const after = await this.git.commitCandidate(
            `fix: 集成验收修复 #${number} 第 ${repair.round} 轮`,
          );
          const dirtyAfter = await this.git.hasChanges();
          if (visualDecision && visualDecision.decision === 'behavior-covered' && (dirtyAfter || after !== before)) {
            visualDecision = { ...visualDecision, decision: 'fix-ui', reason: `${visualDecision.reason}（工作区有变更，已按普通修复处理）` };
          }
          if (visualDecision && ['add-visual-evidence', 'fix-ui'].includes(visualDecision.decision) && after === before)
            return { kind: 'failed', error: { message: '视觉修复决定要求修改文件，但候选提交没有变化', retryable: 'hard-no-auto' } };
          if (visualDecision && visualDecision.decision === 'retry-visual' && (dirtyAfter || after !== before))
            return { kind: 'failed', error: { message: 'retry-visual 决定要求工作区无代码变化', retryable: 'hard-no-auto' } };
          tracker.transaction(number, (record) => {
            Object.assign(record.run.repairs.at(-1)!, {
              after,
              identity: result.identity,
              visualDecision,
            });
          });
        } else {
          // 2.2 正常构建路径：执行任务图，生成结构化代码产物
          await new TaskGraphExecutor({
            number,
            tracker,
            runner: this.deps.aiRunner,
            integration: this.git,
            repository: new GitOperations(config.project.gitRootDir, signal),
            repositoryMutex: this.deps.mainGitMutex,
            worktreeRoot: config.project.worktreeBaseDir,
            projectSubdir: config.project.projectSubDir,
            signal,
            rules,
            aiPolicy: configuredCallPolicy(config.ai),
            install: (cwd, cancel) => this.deps.installDependencies(cwd, cancel),
            onOutput: callbacks.onStreamEvent,
          }).execute();
        }

        signal.throwIfAborted();

        // 2.3 E2E 准备：只有本轮计划对应的配置与清单实际有效，才形成候选提交。
        if (isE2eEnabledForIssue(number, tracker, config)) {
          await prepareUat({
            runner,
            workDir: context.workDir,
            dataDir: tracker.store.dataDir,
            issueIid: number,
            plan: tracker.store.readPlan(number, state().planRevision, state().planDigest),
            e2e: config.e2e,
            ai: config.ai,
            demand: ctx.demand,
            ...callbacks,
          });
        }

        // 2.4 lockfile 变更检测：避免依赖安装不一致导致后续验收失真
        const lockHash = createHash('sha256');
        for (const file of [
          'package.json',
          'package-lock.json',
          'pnpm-lock.yaml',
          'yarn.lock',
          'bun.lock',
          'bun.lockb',
        ]) {
          const filename = path.join(context.workDir, file);
          if (fs.existsSync(filename)) lockHash.update(file).update(fs.readFileSync(filename));
        }
        const digest = lockHash.digest('hex');
        if (state().installedLockDigest !== digest) {
          await this.deps.installDependencies(context.workDir, signal, true);
          tracker.transaction(number, (record) => {
            record.run.installedLockDigest = digest;
          });
        }

        signal.throwIfAborted();

        // 2.5 候选提交形成：构建完成后必须产生可验收的代码快照
        const commit = await this.git.commitCandidate(`chore: 完成 Issue #${number} 构建准备`);
        if (
          !state().integrationBase ||
          !(await this.git.changedContent(state().integrationBase!, commit))
        )
          return {
            kind: 'failed',
            error: {
              message: '整批任务没有有效仓库内容变化，请人工核对需求，无需创建 PR',
              retryable: 'hard-no-auto',
            },
          };
        if (await this.git.hasChanges()) throw new Error('构建后仍存在未纳入候选提交的文件');
        tracker.transaction(number, (record) => {
          record.run.candidateCommit = commit;
          // Build 形成或确认新的候选提交后，UAT 视觉重试计数从该候选版本重新开始。
          record.run.uatReviewRounds = 0;
          record.run.verify = undefined;
          record.run.uat = undefined;
          record.run.uatExecution = undefined;
          record.run.temporaryDirectories = [];
        });
        return { kind: 'completed', output: '任务图已汇总，候选提交已准备' };
      }

      // --- 3. 验证 / UAT 阶段：必须基于稳定候选提交，不允许携带脏状态 ---
      const candidate = spec.id === 'plan' ? undefined : state().candidateCommit;
      if (spec.id !== 'plan') {
        if (!candidate || (await this.git.head()) !== candidate || (await this.git.hasChanges()))
          throw new Error('候选提交或工作目录已改变，不能接受验证结果');
        if (Object.values(state().tasks).some((task) => task.status !== 'merged'))
          throw new Error('仍有未完成的内部任务');
        if (spec.id === 'uat' && state().verify?.commit !== candidate)
          throw new Error('缺少当前候选提交的验证凭证');
      }

      // 3.1 根据 phase 类型创建具体执行器，业务逻辑在各自 Phase 中实现
      const phase = createPhase(spec.id, runner, this.git, this.plan, config, tracker);
      const intent = await phase.run(ctx, callbacks);
      signal.throwIfAborted();

      // 3.2 修复轮次限制：防止重复尝试在无意义循环中耗尽额度
      if (
        intent.kind === 'requestRetryFrom' &&
        state().repairRounds >= config.verifyFixLoop.maxIterations
      )
        return {
          kind: 'failed',
          error: { message: '集成自动修复额度已用完，请人工处理', retryable: 'hard-no-auto' },
        };

      // 3.3 `plan` 阶段成功后，必须保存结构化 plan，并同步到持久化文件
      if (spec.id === 'plan' && intent.kind === 'completed') {
        if (!intent.planContent) throw new Error('计划阶段缺少已校验的结构化内容');
        const plan = tracker.store.savePlan(number, intent.planContent, state().version);
        this.plan.writePlan(renderPlan(plan));
      }

      // 3.4 验收成功后写入凭证：`verify` / `uat` 的通过记录与 reportPath 一并落盘
      if (candidate) {
        if ((await this.git.head()) !== candidate || (await this.git.hasChanges()))
          throw new Error('检查过程中代码发生变化，该次验收结果无效');
        if (intent.kind === 'completed') {
          const reportPath = this.plan.artifactPath(
            spec.id === 'verify' ? ARTIFACTS.verifyReport.filename : ARTIFACTS.uatReport.filename,
          );
          if (spec.id === 'uat') {
            const run = state();
            const runId = run.uatExecution?.runId;
            if (!runId) throw new Error('UAT 缺少当前执行记录');
            const receipt = new UatResultStore(this.plan.dataDirectory).createReceipt(runId, {
              candidateCommit: candidate,
              planRevision: run.planRevision,
              planDigest: run.planDigest!,
              buildGeneration: run.buildGeneration,
            }, reportPath);
            tracker.transaction(number, (record) => {
              record.run.uat = receipt;
              record.run.uatExecution = undefined;
            });
          } else {
            tracker.transaction(number, (record) => {
              record.run.verify = {
                commit: candidate,
                passed: true,
                completedAt: new Date().toISOString(),
                reportPath,
              };
            });
          }
        }
      }

      return intent;
    } catch (error) {
      // --- 4. 统一失败处理：保留上下文并规范失败语义 ---
      if (signal.aborted || tracker.store.isBlocked(number)) throw error;
      return {
        kind: 'failed',
        error: {
          message: (error as Error).message,
          retryable:
            spec.id === 'build' && !(error instanceof RecoveryError) && !(error instanceof UatPreparationError)
              ? 'hard' : 'hard-no-auto',
        },
      };
    }
  }
}
