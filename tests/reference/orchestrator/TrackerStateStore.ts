import { renderPlan } from '../../../src/dag/contracts.js';
import type { IssueTracker } from '../../../src/tracker/IssueTracker.js';
import { IssueState } from '../../../src/tracker/IssueState.js';
import type { PlanPersistence } from '../../../src/persistence/PlanPersistence.js';
import type { OrchestratorStateStore, OrchestrationStateSnapshot, OrchestrationTransition, OrchestrationState } from '../orchestration/index.js';
import { recordToOrchestrationState, orchestrationStateToTrackerUpdate } from './StateAdapter.js';

/** 父状态、历史、进度、审核和预算在一次聚合事务中生效。 */
export class TrackerStateStore implements OrchestratorStateStore {
  constructor(private readonly tracker: IssueTracker, private readonly plan?: PlanPersistence) {}

  getSnapshot(number: number): OrchestrationStateSnapshot {
    const record = this.tracker.get(number);
    if (!record) throw new Error(`Issue #${number} 不存在`);
    return {
      state: record.orchestrationState ?? recordToOrchestrationState(record),
      history: (record.phaseHistory ?? []).filter(entry => entry.planRevision === undefined || (entry.planRevision === record.run!.planRevision && entry.buildGeneration === record.run!.buildGeneration)),
      attempts: record.run!.retryUsed[record.currentPhase ?? 'plan'] ?? 0,
    };
  }

  transitionToRunning(number: number, phaseId: string, startedAt: string): void {
    const preserveSessionId = this.tracker.get(number)?.phaseProgress?.[phaseId]?.status !== 'completed' && this.plan?.readProgress()?.phases[phaseId]?.status !== 'completed';
    this.tracker.transaction(number, record => {
      if (record.run!.stopIntent) throw new Error('停止意图已持久化，禁止启动阶段');
      record.state = IssueState.PhaseRunning;
      record.currentPhase = phaseId;
      record.orchestrationState = { kind: 'running', phaseId };
      record.phaseProgress ??= {};
      record.phaseProgress[phaseId] = { ...record.phaseProgress[phaseId], status: 'in_progress', startedAt, sessionId: preserveSessionId ? record.phaseProgress[phaseId]?.sessionId : undefined };
      const count = record.run!.phaseExecutions[phaseId] ?? 0;
      record.run!.phaseExecutions[phaseId] = count + 1;
      if (count) record.retryCount = (record.retryCount ?? 0) + 1;
    });
    // 文档进度仅为可重建投影。
    try { this.plan?.updatePhaseProgress(phaseId, 'in_progress', undefined, { preserveSessionId }); } catch { /* 权威状态已提交，投影可在下次读取时重建。 */ }
  }

  applyTransition(number: number, transition: OrchestrationTransition & { expectedPlanRevision?: number; reviewFeedback?: string }): void {
    const update = orchestrationStateToTrackerUpdate(transition.nextState);
    const phase = transition.historyEntry.phaseId;
    const outcome = transition.historyEntry.outcome;
    const current = this.tracker.transaction(number, record => {
      const run = record.run!;
      if (run.stopIntent || record.state === IssueState.Cancelled) throw new Error('停止后的回调不能推进状态');
      if (outcome === 'gate-approved' || outcome === 'gate-rejected') {
        if (record.orchestrationState?.kind !== 'gate-waiting' || run.review?.decision !== 'waiting' || run.planRevision !== transition.expectedPlanRevision) throw new Error('审核版本或状态冲突');
        run.review = { revision: run.planRevision, decision: outcome === 'gate-approved' ? 'approved' : 'rejected', source: transition.historyEntry.approvalSource };
        if (outcome === 'gate-rejected') {
          const plan = this.tracker.store.readPlan(number, run.planRevision, run.planDigest);
          run.review.feedback = transition.reviewFeedback;
          run.reviewHistory ??= [];
          run.reviewHistory.push({ round: run.reviewHistory.length + 1, revision: run.planRevision, feedback: transition.reviewFeedback ?? '', timestamp: new Date().toISOString(), planSnapshot: renderPlan(plan), reviewedSessionId: record.phaseProgress?.plan?.sessionId });
          for (const progress of Object.values(record.phaseProgress ?? {})) Object.assign(progress, { status: 'pending', startedAt: undefined, completedAt: undefined });
        }
      }
      record.phaseHistory = [...(record.phaseHistory ?? []), { ...transition.historyEntry, planRevision: run.planRevision, buildGeneration: run.buildGeneration }];
      record.orchestrationState = transition.nextState;
      record.state = update.state;
      Object.assign(record, update.extra);
      record.attempts = transition.nextAttempts;
      if (outcome === 'failed' && transition.nextState.kind === 'running') run.retryUsed[phase] = (run.retryUsed[phase] ?? 0) + 1;
      if (outcome === 'retried-from') {
        run.buildEntry = 'repair-integration';
        run.repairRounds++;
        run.repairs.push({ round: run.repairRounds, report: transition.historyEntry.retryFromContext?.rawReport ?? transition.historyEntry.errorMessage ?? '', source: phase });
        run.verify = undefined;
        run.uat = undefined;
      }
      record.phaseProgress ??= {};
      const progress = record.phaseProgress[phase] ?? { status: 'pending' as const };
      if (outcome === 'completed' || outcome === 'gate-approved') Object.assign(progress, { status: 'completed', completedAt: transition.historyEntry.endedAt ?? new Date().toISOString(), sessionId: transition.historyEntry.sessionId });
      else if (outcome === 'failed') Object.assign(progress, { status: 'failed', error: transition.historyEntry.errorMessage });
      else if (outcome === 'gated') progress.status = 'gate_waiting';
      else progress.status = 'pending';
      record.phaseProgress[phase] = progress;
    });
    const progress = current.phaseProgress?.[phase];
    try { if (progress) this.plan?.updatePhaseProgress(phase, progress.status, progress.error); } catch { /* 展示副本写入失败不回滚权威状态。 */ }
    if (current.state === IssueState.Failed) this.tracker.emitFailure(number);
  }
  clearHistory(number: number): void { this.tracker.clearPhaseHistory(number); }
}
export type { OrchestrationState };
