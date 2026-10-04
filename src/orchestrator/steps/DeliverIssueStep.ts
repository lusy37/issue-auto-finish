import { ISSUE_LABELS, withWorkbenchLabels } from '../../clients/IssueLabels.js';
import type { IssueRecord } from '../../tracker/IssueRecord.js';
import { applyIssueLifecycleEvent } from '../../tracker/IssueLifecycle.js';
import type {
  IssueProcessingContext,
  OrchestratorDeps,
  WorkflowRunResult,
} from '../IssueProcessingContext.js';
import { deliverIssue } from '../../dag/DeliveryService.js';

/** 所有执行阶段通过后，只在交付成功时写入任务成功终态。 */
export async function deliverIssueStep(
  ctx: IssueProcessingContext,
  deps: OrchestratorDeps,
  phaseResult: WorkflowRunResult,
): Promise<void> {
  const number = ctx.issue.number;
  const record = deps.tracker.get(number);
  if (!record) throw new Error('任务不存在');
  const execution = record.run;
  const startedLifecycle = record.lifecycle;
  const assertActive = (current: IssueRecord | undefined) => {
    const run = current?.run;
    const lifecycle = current?.lifecycle;
    if (
      !current ||
      !run ||
      !lifecycle ||
      deps.signal?.aborted ||
      run.stopIntent ||
      ['paused', 'cancelled', 'failed'].includes(lifecycle.kind) ||
      (lifecycle.kind !== startedLifecycle.kind && lifecycle.kind !== 'delivering') ||
      run.planRevision !== execution.planRevision ||
      run.buildGeneration !== execution.buildGeneration ||
      run.workflow.generation !== execution.workflow.generation ||
      run.dispatchId !== execution.dispatchId ||
      run.candidateCommit !== execution.candidateCommit
    ) {
      throw new Error('交付已中止或执行身份已失效');
    }
  };
  assertActive(record);
  const url = await deliverIssue(ctx, deps);
  assertActive(deps.tracker.get(number));
  await deps.github.updateIssueLabels(
    number,
    withWorkbenchLabels(ctx.issue.labels, [ISSUE_LABELS.done]),
  );
  // 外部请求返回后，在同一次落盘事务中复核停止意图与图轮次，避免迟到结果覆盖用户操作。
  deps.tracker.transaction(number, (current) => {
    assertActive(current);
    Object.assign(current, {
      completedAt: new Date().toISOString(),
      worktreeCleanedAt: undefined,
      prUrl: url,
      deliveryPending: false,
    });
    applyIssueLifecycleEvent(current, { type: 'delivery-confirmed' });
  });
  if (!phaseResult.serversStarted || !deps.config.preview.keepAfterComplete)
    await deps.stopPreviewServers(number);
}
