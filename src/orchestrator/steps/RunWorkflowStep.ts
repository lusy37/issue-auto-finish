
import type { GitOperations } from '../../git/GitOperations.js';
import type { PlanPersistence } from '../../persistence/PlanPersistence.js';
import type { IssueProcessingContext, OrchestratorDeps, WorkflowRunResult } from '../IssueProcessingContext.js';
import { IssueWorkflow } from '../IssueWorkflow.js';
import { DagPhaseRunner } from '../DagPhaseRunner.js';
import { isShuttingDown } from '../../shutdown/ShutdownSignal.js';
import { ServiceShutdownError } from '../../errors/index.js';
import { deliverIssueStep } from './DeliverIssueStep.js';
import { syncResultToIssue } from './PhaseHelpers.js';
import { ARTIFACTS, getPhaseArtifacts } from '../../shared/runtime/artifacts.js';
import type { IssueLifecycle } from '../../tracker/IssueLifecycle.js';
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

  let serversStarted = deps.isPreviewRunning(issueIid);

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
          // 每次验收都从当前代码启动新进程，包含集成修复和暂停继续，不能依赖服务自动加载代码。
          await deps.stopPreviewServers(issueIid);
          serversStarted = false;
          ctx.phaseCtx.ports = undefined;
          ctx.wtCtx.ports = undefined;
          deps.signal?.throwIfAborted();
          const ports = await deps.startPreviewServers(ctx.wtCtx, ctx.issue);
          deps.signal?.throwIfAborted();
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
        if (isShuttingDown()) throw new ServiceShutdownError();
      },
      autoReview: () => {
        if (!deps.config.review.enabled) {
          if (!wtPlan.isArtifactReady(ARTIFACTS.plan.filename)) throw new Error('完整计划尚未保存，不能按配置自动通过审核');
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
      await syncResultToIssue(getPhaseArtifacts(phaseId), issueIid, phaseId, deps, issueIid, wtPlan, operation);
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
  const paused = finalRecord !== undefined && isPipelinePaused(finalRecord.lifecycle);

  if (paused) {
    logger.info('Pipeline paused', { number: issueIid, lifecycle: finalRecord?.lifecycle.kind });
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
function isPipelinePaused(lifecycle: IssueLifecycle): boolean {
  return ['waiting', 'paused', 'failed'].includes(lifecycle.kind);
}
