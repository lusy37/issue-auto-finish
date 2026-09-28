import { phaseCallId } from '../orchestration/ExecutionIds.js';
import { buildCallOptions, configuredCallPolicy } from '../ai-runner/CallPolicy.js';
import { parseJsonOutput } from '../prompts/parseJsonOutput.js';
import { integrationRepairPrompt, uatPreparationPrompt } from '../prompts/taskExecution.js';
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
import { decodePlanContent } from '../dag/codecs/TaskPlanCodec.js';

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
    const state = () => tracker.get(number)!.run!;
    const callbacks = {
      onStreamEvent: (
        event: Parameters<NonNullable<Parameters<typeof runner.run>[0]['onStreamEvent']>>[0],
      ) =>
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
        record.run!.temporaryFiles = [
          ...new Set([
            ...(record.run!.temporaryFiles ?? []).filter((existing) => existing !== file),
            ...(present ? [file] : []),
          ]),
        ];
      });
    if (spec.kind === 'gate') throw new Error('审核必须由 LangGraph interrupt 执行');

    try {
      signal.throwIfAborted();

      // --- 2. 构建阶段：确保候选提交与修复能力被正确应用 ---
      if (spec.id === 'build') {
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
          tracker.transaction(number, (record) => {
            record.run!.repairs.at(-1)!.before = before;
          });
          const result = await runner.run({
            workDir: context.workDir,
            ...buildCallOptions(configuredCallPolicy(config.ai), 'integration-repair'),
            prompt: integrationRepairPrompt(
              tracker.store.readPlan(number, state().planRevision),
              repair.report,
              rules,
            ),
            ...callbacks,
          });
          if (!result.success)
            return {
              kind: 'failed',
              error: { message: result.errorMessage || '集成修复失败', retryable: 'hard' },
            };
          if (result.identity) tracker.assertIdentity(result.identity);
          const after = await this.git.commitCandidate(
            `fix: 集成验收修复 #${number} 第 ${repair.round} 轮`,
          );
          tracker.transaction(number, (record) => {
            Object.assign(record.run!.repairs.at(-1)!, { after, identity: result.identity });
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

        // 2.3 E2E 准备：若未配置浏览器测试文件，则由 AI 生成最小准备内容
        if (
          isE2eEnabledForIssue(number, tracker, config) &&
          !fs.existsSync(path.resolve(context.workDir, config.e2e.configFile))
        ) {
          const prepared = await runner.run({
            workDir: context.workDir,
            ...buildCallOptions(configuredCallPolicy(config.ai), 'uat-prepare'),
            prompt: uatPreparationPrompt(
              ctx.demand,
              tracker.store.readPlan(number, state().planRevision),
              config.e2e.configFile,
            ),
            ...callbacks,
          });
          if (!prepared.success)
            return {
              kind: 'failed',
              error: { message: prepared.errorMessage || '浏览器测试准备失败', retryable: 'hard' },
            };
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
            record.run!.installedLockDigest = digest;
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
          record.run!.candidateCommit = commit;
          record.run!.verify = undefined;
          record.run!.uat = undefined;
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
        const content = decodePlanContent(parseJsonOutput(intent.output ?? ''));
        const plan = tracker.store.savePlan(number, content, state().version);
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
          const runId =
            spec.id === 'uat'
              ? (JSON.parse(this.plan.readFile(ARTIFACTS.uatRun.filename) ?? '{}').runId as
                  | string
                  | undefined)
              : undefined;
          tracker.transaction(number, (record) => {
            const receipt = {
              commit: candidate,
              passed: true as const,
              completedAt: new Date().toISOString(),
              reportPath,
              runId,
            };
            if (spec.id === 'verify') record.run!.verify = receipt;
            else {
              record.run!.uat = receipt;
              record.uatRunId = runId;
            }
          });
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
            spec.id === 'build' && !(error instanceof RecoveryError) ? 'hard' : 'hard-no-auto',
        },
      };
    }
  }
}
