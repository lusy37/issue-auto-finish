import { IssueState } from '../../tracker/IssueState.js';
import type { IssueProcessingContext, OrchestratorDeps, PhaseLoopResult } from '../IssueProcessingContext.js';
import { deliverIssue } from '../../dag/DeliveryService.js';

/** 所有执行阶段通过后，只在交付成功时写入任务成功终态。 */
export async function executeCompletion(ctx: IssueProcessingContext, deps: OrchestratorDeps, phaseResult: PhaseLoopResult): Promise<void> {
  const number=ctx.issue.number;
  const record=deps.tracker.get(number);
  if (!record || record.state===IssueState.Cancelled) throw new Error('任务已取消');
  const url = await deliverIssue(ctx, deps);
  await deps.github.updateIssueLabels(ctx.issue.number,[...ctx.issue.labels.filter(l=>!l.startsWith('auto-finish')),'auto-finish:done']);
  if (deps.tracker.get(number)?.state===IssueState.Cancelled) return;
  deps.tracker.updateState(number,IssueState.Completed,{deliveryPending:false,completedAt:new Date().toISOString(),worktreeCleanedAt:undefined,prUrl:url});
  if (!phaseResult.serversStarted || !deps.config.preview.keepAfterComplete) await deps.stopPreviewServers(number);
}
