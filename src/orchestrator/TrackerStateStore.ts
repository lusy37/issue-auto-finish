import type { IssueTracker } from '../tracker/IssueTracker.js';
import { IssueState } from '../tracker/IssueState.js';
import type { PlanPersistence } from '../persistence/PlanPersistence.js';
import { logger as rootLogger } from '../logger.js';
import type {
  OrchestratorStateStore,
  OrchestrationStateSnapshot,
  OrchestrationTransition,
  OrchestrationState,
  PhaseHistoryEntry,
} from '../orchestration/index.js';
import {
  recordToOrchestrationState,
  orchestrationStateToTrackerUpdate,
} from './StateAdapter.js';


export class TrackerStateStore implements OrchestratorStateStore {
  private readonly logger = rootLogger.child('TrackerStateStore');
  private readonly tracker: IssueTracker;

  constructor(tracker: IssueTracker, private readonly plan?: PlanPersistence) {
    this.tracker = tracker;
  }

  getSnapshot(number: number): OrchestrationStateSnapshot {
    const record = this.tracker.get(number);
    if (!record) {
      throw new Error(`Issue #${number} not found in tracker`);
    }
    const state: OrchestrationState =
      record.orchestrationState ?? recordToOrchestrationState(record);
    const history: PhaseHistoryEntry[] =
      record.phaseHistory ?? [];
    return {
      state,
      history,
      attempts: record.attempts ?? 0,
    };
  }

  transitionToRunning(number: number, phaseId: string, _startedAt: string): void {
    const record = this.tracker.get(number);
    if (!record) return;
    const previous = this.plan?.readProgress()?.phases[phaseId];
    this.plan?.updatePhaseProgress(phaseId, 'in_progress', undefined, {
      preserveSessionId: previous?.status === 'failed' || previous?.status === 'in_progress',
    });
    if (record.phaseProgress?.[phaseId]?.startedAt || record.phaseHistory?.some(h => h.phaseId===phaseId && ['completed','failed'].includes(h.outcome))) this.tracker.updateState(number, record.state, {retryCount:(record.retryCount??0)+1});
    const next: OrchestrationState = { kind: 'running', phaseId };
    this.tracker.setOrchestrationState(number, next, IssueState.PhaseRunning, {
      currentPhase: phaseId,
    });
    this.tracker.updatePhaseProgress(number, phaseId, {
      status: 'in_progress',
      startedAt: new Date().toISOString(),
    });
  }

  applyTransition(number: number, transition: OrchestrationTransition): void {
    const update = orchestrationStateToTrackerUpdate(transition.nextState);
    if (this.tracker.get(number)?.state===IssueState.Cancelled) return;
    this.tracker.appendPhaseHistory(number, transition.historyEntry);
    this.tracker.setOrchestrationState(number, transition.nextState, update.state, {...update.extra, attempts:transition.nextAttempts});

    const phaseId = transition.historyEntry.phaseId;
    const outcome = transition.historyEntry.outcome;
    this.applyPhaseProgressForOutcome(number, phaseId, outcome, transition);
    const progress = this.tracker.get(number)?.phaseProgress?.[phaseId];
    if (progress) this.plan?.updatePhaseProgress(phaseId, progress.status, progress.error);
    if(update.state===IssueState.Failed) this.tracker.emitFailure(number);

    this.logger.debug('State transition applied', {
      number,
      nextState: transition.nextState.kind,
      historyEntry: outcome,
    });
  }

  /** 清理某个 issue 的历史（用于 reset / cancel） */
  clearHistory(number: number): void {
    this.tracker.clearPhaseHistory(number);
  }

  private applyPhaseProgressForOutcome(
    number: number,
    phaseId: string,
    outcome: PhaseHistoryEntry['outcome'],
    transition: OrchestrationTransition,
  ): void {
    if (!phaseId) return;

    if (outcome === 'completed') {
      this.tracker.updatePhaseProgress(number, phaseId, {
        status: 'completed',
        completedAt: transition.historyEntry.endedAt ?? new Date().toISOString(),
        sessionId: transition.historyEntry.sessionId,
      });
      return;
    }
    if (outcome === 'failed') {
      this.tracker.updatePhaseProgress(number, phaseId, {
        status: 'failed',
        error: transition.historyEntry.errorMessage,
      });
      return;
    }
    if (outcome === 'gated') {
      this.tracker.updatePhaseProgress(number, phaseId, { status: 'gate_waiting' });
      return;
    }
    if (outcome === 'gate-approved') {
      this.tracker.updatePhaseProgress(number, phaseId, { status: 'completed' });
      return;
    }
    if (outcome === 'gate-rejected') {
      this.tracker.updatePhaseProgress(number, phaseId, { status: 'pending' });
      return;
    }
    if (outcome === 'retried-from') {
      this.tracker.updatePhaseProgress(number, phaseId, { status: 'pending' });
    }
  }
}

/** Re-export OrchestrationState for convenient use in adapters */
export type { OrchestrationState };
