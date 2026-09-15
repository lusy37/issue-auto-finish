import { IssueState, deriveOrchestrationState, type IssueRecord } from '../../tracker/IssueState.js';
import type { IssueProcessingContext, OrchestratorDeps, WorkflowRunResult } from '../IssueProcessingContext.js';
import { deliverIssue } from '../../dag/DeliveryService.js';

/** 所有执行阶段通过后，只在交付成功时写入任务成功终态。 */
export async function deliverIssueStep(ctx: IssueProcessingContext, deps: OrchestratorDeps, phaseResult: WorkflowRunResult): Promise<void> {
  const number = ctx.issue.number;
  const record = deps.tracker.get(number);
  if (!record) throw new Error('任务不存在');
  const execution = record.run!;
  const assertActive = (current: IssueRecord | undefined) => {
    const run = current?.run;
    if (!current || !run || deps.signal?.aborted || run.stopIntent
      || [IssueState.Paused, IssueState.Cancelled, IssueState.Failed].includes(current.state)
      || (current.state !== record.state && current.state !== IssueState.Delivering)
      || run.planRevision !== execution.planRevision || run.buildGeneration !== execution.buildGeneration
      || run.workflow.generation !== execution.workflow.generation
      || run.dispatchId !== execution.dispatchId || run.candidateCommit !== execution.candidateCommit) {
      throw new Error('交付已中止或执行身份已失效');
    }
  };
  assertActive(record);
  const url = await deliverIssue(ctx, deps);
  assertActive(deps.tracker.get(number));
  await deps.github.updateIssueLabels(number, [...ctx.issue.labels.filter(l => !l.startsWith('auto-finish')), 'auto-finish:done']);
  // 外部请求返回后，在同一次落盘事务中复核停止意图与图轮次，避免迟到结果覆盖用户操作。
  deps.tracker.transaction(number, current => {
    assertActive(current);
    Object.assign(current, { state: IssueState.Completed, deliveryPending: false, completedAt: new Date().toISOString(), worktreeCleanedAt: undefined, prUrl: url, lastError: undefined, failedAtState: undefined });
    current.orchestrationState = deriveOrchestrationState(current);
  });
  if (!phaseResult.serversStarted || !deps.config.preview.keepAfterComplete) await deps.stopPreviewServers(number);
}
