import { IssueState, type IssueRecord } from '../../../src/tracker/IssueState.js';
import type { OrchestrationState } from '../orchestration/index.js';

export {
  deriveOrchestrationState as recordToOrchestrationState,
} from '../../../src/tracker/IssueState.js';


export function orchestrationStateToTrackerUpdate(
  state: OrchestrationState,
): { state: IssueState; extra: Partial<IssueRecord> } {
  switch (state.kind) {
    case 'queued':
      return { state: IssueState.BranchCreated, extra: { currentPhase: undefined } };
    case 'running':
      return { state: IssueState.PhaseRunning, extra: { currentPhase: state.phaseId } };
    case 'gate-waiting':
      return { state: IssueState.PhaseWaiting, extra: { currentPhase: state.phaseId } };
    case 'gate-approved':
      return { state: IssueState.PhaseApproved, extra: { currentPhase: state.phaseId } };
    case 'paused':
      return {
        state: IssueState.Paused,
        extra: { pausedAtPhase: state.phaseId, currentPhase: state.phaseId },
      };
    case 'pipeline-completed':
      return { state: IssueState.Delivering, extra: { deliveryPending: true, currentPhase: undefined } };
    case 'pipeline-failed':
      return {
        state: IssueState.Failed,
        extra: {
          failedAtState: IssueState.PhaseRunning,
          currentPhase: state.failedAt,
          lastError: state.error?.message,
          lastErrorRetryable: state.retryable === 'auto'
            ? true
            : (state.error?.retryable === 'hard-no-auto' ? false : true),
        },
      };
    case 'conflict-resolving':
      return { state: IssueState.ResolvingConflict, extra: {} };
  }
}
