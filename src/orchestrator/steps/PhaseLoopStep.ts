
import type { GitOperations } from '../../git/GitOperations.js';
import type { PlanPersistence } from '../../persistence/PlanPersistence.js';
import type { IssueProcessingContext, OrchestratorDeps, PhaseLoopResult } from '../IssueProcessingContext.js';
import {
  Orchestrator,
  buildPipeline,
  PLAN_MODE_TRANSITIONS,
} from '../../orchestration/index.js';
import { StandardPhaseRunner } from '../StandardPhaseRunner.js';
import { isShuttingDown } from '../../shutdown/ShutdownSignal.js';
import { ServiceShutdownError, PhaseAbortedError } from '../../errors/index.js';
import { TrackerStateStore } from '../TrackerStateStore.js';
import { DefaultSideEffectExecutor } from '../DefaultSideEffectExecutor.js';
import { createPhase } from '../../phases/PhaseFactory.js';
import { isE2eEnabledForIssue } from '../../e2e/E2eSettings.js';
import { IssueState } from '../../tracker/IssueState.js';
import { logger as rootLogger } from '../../logger.js';

const logger = rootLogger.child('PhaseLoopStep');

export async function executePhaseLoop(
  ctx: IssueProcessingContext,
  deps: OrchestratorDeps,
  wtGit: GitOperations,
  wtPlan: PlanPersistence,
): Promise<PhaseLoopResult & { paused: boolean }> {
  const issueIid = ctx.issue.number;
  const pipeline = buildPipeline(
    {
      e2e: isE2eEnabledForIssue(issueIid, deps.tracker, deps.config),
    },
    PLAN_MODE_TRANSITIONS,
  );



  const phaseRunner = new StandardPhaseRunner({
    aiRunner: deps.aiRunner,
    wtGit,
    wtPlan,
    config: deps.config,
    eventBus: deps.eventBus,
  });

  const stateStore = new TrackerStateStore(deps.tracker, wtPlan);

  const sideEffectExecutor = new DefaultSideEffectExecutor({
    issueCtx: ctx,
    deps,
    wtGit,
    wtPlan,
    phaseFactory: phaseId => createPhase(phaseId, deps.aiRunner, wtGit, wtPlan, deps.config),
  });

  let serversStarted = await maybeStartPreviewServers(ctx, deps);

  const orchestrator = new Orchestrator(
    pipeline,
    {
      async run(spec, phaseContext) {
        if (spec.id === 'uat' && deps.config.preview.enabled) {
          // 同一次 drive 中完成构建后才启动预览，并把实际端口传给本次 UAT。
          const ports = serversStarted && ctx.phaseCtx.ports
            ? ctx.phaseCtx.ports
            : await deps.startPreviewServers(ctx.wtCtx, ctx.issue);
          if (!ports) return { kind: 'failed', error: { message: '预览服务启动失败，请检查预览日志和启动命令', retryable: 'hard-no-auto' } };
          ctx.phaseCtx.ports = ports;
          ctx.wtCtx.ports = ports;
          serversStarted = true;
          return phaseRunner.run(spec, { ...phaseContext, ports });
        }
        return phaseRunner.run(spec, phaseContext);
      },
    },
    stateStore,
    sideEffectExecutor,
    {
      maxIterations: 100,
      checkShutdown: () => {
        if (deps.tracker.get(issueIid)?.state === IssueState.Cancelled) throw new PhaseAbortedError('', 'restart');
        if (isShuttingDown()) throw new ServiceShutdownError();
        const pendingAction = deps.consumePendingAction?.(issueIid);
        if (pendingAction) {
          const phaseId = ctx.record?.currentPhase ?? '';
          throw new PhaseAbortedError(phaseId, pendingAction);
        }
      },
      onGateWaiting: (_iid, state) => {
        if (state.phaseId === 'review' && deps.shouldAutoApprove(ctx.issue.labels ?? [])) {
          logger.info('Auto-approving review gate by label match', { number: issueIid });
          return { action: 'approve' };
        }
        return undefined;
      },
    },
  );

  await orchestrator.drive(issueIid, {
    issueIid,
    demand: ctx.demand,
    branchName: ctx.branchName,
    workDir: ctx.wtCtx.workDir,
    pipelineMode: ctx.pipelineDef.mode,
    ports: ctx.phaseCtx.ports,
    workspace: ctx.phaseCtx.workspace,
  });

  const finalRecord = deps.tracker.get(issueIid);
  const paused = finalRecord !== undefined && isPipelinePaused(finalRecord.state);

  if (paused) {
    logger.info('Pipeline paused', { number: issueIid, state: finalRecord?.state });
  }

  return { paused, serversStarted };
}

/**
 * 流水线是否处于「需要外部干预」的暂停态。
 *
 * - PhaseWaiting：阶段进入 gate 等人工
 * - Paused：用户主动暂停
 * - Failed：失败（manual 重试由用户触发）
 *
 * 这些状态下 PhaseLoopStep 应该 return paused=true，让 PipelineOrchestrator 不要继续走 CompletionStep。
 */
function isPipelinePaused(state: IssueState): boolean {
  return (
    state === IssueState.PhaseWaiting ||
    state === IssueState.Paused ||
    state === IssueState.Failed
  );
}

/**
 * 在 drive 之前启动或恢复预览服务器。
 *
 * 仅在「断点恢复且已跨过 deploysPreview 阶段」时才尝试恢复，
 * 否则交由 deploysPreview 阶段（通常是 build）自己触发启动。
 *
 * - phaseCtx.ports 已存在 → 直接复用
 * - 已分配过端口且服务器仍在跑 → 复用
 * - 已分配过端口但服务器没跑 → 重新启动
 */
async function maybeStartPreviewServers(
  ctx: IssueProcessingContext,
  deps: OrchestratorDeps,
): Promise<boolean> {
  const issueIid = ctx.issue.number;
  if (!deps.shouldDeployServers(issueIid)) return false;

  if (ctx.phaseCtx.ports && deps.isPreviewRunning(issueIid)) {
    logger.debug('Preview ports already in phaseCtx, skipping start', { number: issueIid });
    return true;
  }

  if (!shouldRestoreOnResume(ctx)) return false;

  const existingPorts = deps.getPortsForIssue(issueIid);
  if (!existingPorts) {
    const ports = await deps.startPreviewServers(ctx.wtCtx, ctx.issue);
    if (ports) {
      ctx.phaseCtx.ports = ports;
      ctx.wtCtx.ports = ports;
      return true;
    }
    return false;
  }

  if (deps.isPreviewRunning(issueIid)) {
    logger.info('Restored preview ports from allocator', { number: issueIid, ...existingPorts });
    ctx.phaseCtx.ports = existingPorts;
    ctx.wtCtx.ports = existingPorts;
    return true;
  }

  const ports = await deps.startPreviewServers(ctx.wtCtx, ctx.issue);
  if (ports) {
    ctx.phaseCtx.ports = ports;
    ctx.wtCtx.ports = ports;
    return true;
  }
  return false;
}

/**
 * 判断当前 issue 是否处于 resume 状态，且 currentPhase 已经跨过了 deploysPreview 阶段。
 * 仅在这种情况下，预览启动才需要在 drive 之前执行（恢复端口）。
 */
function shouldRestoreOnResume(ctx: IssueProcessingContext): boolean {
  if (!ctx.isRetry || !ctx.record) return false;
  const deployIdx = ctx.pipelineDef.phases.findIndex((p) => p.deploysPreview === true);
  if (deployIdx < 0) return false;
  const currentPhaseId = ctx.record.currentPhase;
  if (!currentPhaseId) return false;
  const currentIdx = ctx.pipelineDef.phases.findIndex((p) => p.name === currentPhaseId);
  return currentIdx >= deployIdx;
}
