
import type { GitOperations } from '../../git/GitOperations.js';
import type { PlanPersistence } from '../../persistence/PlanPersistence.js';
import type { IssueProcessingContext, OrchestratorDeps, WorkflowRunResult } from '../IssueProcessingContext.js';
import { IssueWorkflow } from '../IssueWorkflow.js';
import { DagPhaseRunner } from '../DagPhaseRunner.js';
import { isShuttingDown } from '../../shutdown/ShutdownSignal.js';
import { ServiceShutdownError, PhaseAbortedError } from '../../errors/index.js';
import { deliverIssueStep } from './DeliverIssueStep.js';
import { syncResultToIssue } from './PhaseHelpers.js';
import { createPhase } from '../../phases/PhaseFactory.js';
import { IssueState } from '../../tracker/IssueState.js';
import { logger as rootLogger } from '../../logger.js';

const logger = rootLogger.child('RunWorkflowStep');

export async function runWorkflow(
  ctx: IssueProcessingContext,
  deps: OrchestratorDeps,
  wtGit: GitOperations,
  wtPlan: PlanPersistence,
): Promise<WorkflowRunResult & { paused: boolean }> {
  const issueIid = ctx.issue.number;
  const phaseRunner = new DagPhaseRunner(deps, wtGit, wtPlan);

  let serversStarted = await maybeStartPreviewServers(ctx, deps);

  const workflow = new IssueWorkflow({
    tracker: deps.tracker,
    events: deps.eventBus,
    number: issueIid,
    maxRetries: deps.config.poll.maxRetries,
    maxRepairs: deps.config.verifyFixLoop.enabled ? deps.config.verifyFixLoop.maxIterations : 0,
    signal: deps.signal,
    runner: {
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
      checkShutdown: () => {
        if (deps.signal?.aborted || deps.tracker.get(issueIid)?.run?.stopIntent || deps.tracker.get(issueIid)?.state === IssueState.Cancelled) throw new PhaseAbortedError('', 'restart');
        if (isShuttingDown()) throw new ServiceShutdownError();
        const pendingAction = deps.consumePendingAction?.(issueIid);
        if (pendingAction) {
          const phaseId = ctx.record?.currentPhase ?? '';
          throw new PhaseAbortedError(phaseId, pendingAction);
        }
      },
      autoReview: () => {
        if (!deps.config.review.enabled) {
          if (!wtPlan.isArtifactReady('01-plan.md')) throw new Error('完整计划尚未保存，不能按配置自动通过审核');
          logger.info('计划已保存，按配置自动通过审核', { number: issueIid });
          return 'configuration';
        }
        if (deps.shouldAutoApprove(ctx.issue.labels ?? [])) {
          logger.info('Auto-approving review gate by label match', { number: issueIid });
          return 'label';
        }
        return undefined;
      },
    publish: async (phaseId, operation) => {
      const phase = createPhase(phaseId, deps.aiRunner, wtGit, wtPlan, deps.config);
      await syncResultToIssue(phase, ctx.phaseCtx, issueIid, phaseId, deps, issueIid, wtPlan, operation);
    },
    deliver: () => deliverIssueStep(ctx, deps, { serversStarted }),
    context: {
    issueIid,
    demand: ctx.demand,
    branchName: ctx.branchName,
    workDir: ctx.wtCtx.workDir,
    pipelineMode: ctx.pipelineDef.mode,
    ports: ctx.phaseCtx.ports,
    workspace: ctx.phaseCtx.workspace,
    },
  });
  await workflow.drive();

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
 * 这些状态供调用方展示暂停原因；图自身保存待恢复节点。
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
 * 同一次执行完成 build 时，在进入 UAT 前启动预览。
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
