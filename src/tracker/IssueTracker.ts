import { IssueRecord, IssueState, type PhaseProgress, deriveOrchestrationState } from './IssueState.js';
import { type PipelineDef } from '../pipeline/PipelineMetadata.js';
import { IssueNotFoundError } from '../errors/index.js';
import { ActionLifecycleManager } from '../lifecycle/ActionLifecycleManager.js';
import { IssueRunStore } from '../dag/IssueRunStore.js';
import { newIssueRun, sameIdentity, type ExecutionIdentity } from '../dag/contracts.js';
import { type ExecutableTask, issueToExecutableTask } from './ExecutableTask.js';
import { getIssueNumber } from './IssueRecordHelper.js';
import { logger as rootLogger } from '../logger.js';
import { eventBus } from '../events/EventBus.js';
import type { OrchestrationState, PhaseHistoryEntry } from '../orchestration/index.js';
import { PHASE_IDS, type PhaseId } from '../orchestration/WorkflowState.js';

const logger = rootLogger.child('IssueTracker');

export class IssueTracker {
  readonly store: IssueRunStore;
  private lifecycleManagers: Map<string, ActionLifecycleManager>;

  constructor(
    dataDir: string,
    lifecycleManagers: Map<string, ActionLifecycleManager>,
  ) {
    this.store = new IssueRunStore(dataDir);
    this.lifecycleManagers = lifecycleManagers;
  }

  transaction(issueIid: number, update: (record: IssueRecord) => void): IssueRecord {
    const record = this.store.transaction(issueIid, update);
    eventBus.emitTyped('issue:stateChanged', { issueIid, state: record.state, record });
    return record;
  }

  assertIdentity(identity: ExecutionIdentity): void {
    const run = this.get(identity.issueNumber)?.run;
    if (!run || this.store.isBlocked(identity.issueNumber) || run.stopIntent || run.planRevision !== identity.planRevision || run.buildGeneration !== identity.buildGeneration || run.dispatchId !== identity.dispatchId || !sameIdentity(run.calls[identity.callId]?.identity, identity)) throw new Error('执行身份已失效');
    if (identity.taskId.startsWith('$phase:') && this.get(identity.issueNumber)?.currentPhase !== identity.taskId.slice(7)) throw new Error('父阶段调用身份已失效');
    if (run.activeCalls?.[identity.taskId] && run.activeCalls[identity.taskId] !== identity.callId) throw new Error('调用已被新的执行替代');
    const task = run.tasks[identity.taskId];
    if (task && (task.attemptNo !== identity.attemptNo || task.identity?.callId !== identity.callId)) throw new Error('任务尝试身份已失效');
  }

  private getAllRecords(): IssueRecord[] { return this.store.all(); }

  private lifecycleFor(record: IssueRecord): ActionLifecycleManager {
    if (record.pipelineMode) {
      const lm = this.lifecycleManagers.get(record.pipelineMode);
      if (lm) return lm;
    }
    // Fallback: 'plan-mode' or first registered manager
    return this.lifecycleManagers.get('plan-mode') ?? this.lifecycleManagers.values().next().value!;
  }

  get(issueIid: number): IssueRecord | undefined { return this.store.get(issueIid); }

  create(record: Omit<IssueRecord, 'createdAt' | 'updatedAt' | 'attempts'>): IssueRecord {
    const now = new Date().toISOString();
    const full: IssueRecord = {
      ...record,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    full.orchestrationState = deriveOrchestrationState(full);
    full.phaseHistory ??= [];
    full.run ??= newIssueRun();
    this.store.insert(getIssueNumber(full), full);
    logger.info('Issue tracked', { issueIid: getIssueNumber(full), state: record.state });
    const saved = this.get(getIssueNumber(full))!;
    eventBus.emitTyped('issue:created', saved);
    return saved;
  }

  updateState(issueIid: number, state: IssueState, extra?: Partial<IssueRecord>): void {
    const record = this.get(issueIid);
    if (!record) {
      throw new IssueNotFoundError(issueIid);
    }
    record.state = state;
    record.updatedAt = new Date().toISOString();
    if (state === IssueState.Completed) {
      record.lastError = undefined;
      record.failedAtState = undefined;
    }
    if (extra) {
      Object.assign(record, extra);
    }
    record.orchestrationState = deriveOrchestrationState(record);
    this.store.replace(record);
    logger.info('Issue state updated', { issueIid, state });
    eventBus.emitTyped('issue:stateChanged', { issueIid, state, record });
  }

  /**
   * 把编排核心的 OrchestrationState 持久化到 record.orchestrationState。
   *
   * 同时同步 IssueRecord 的状态字段（state/currentPhase/...），供工作台展示与轮询使用。
   * `extra` 用于附加领域字段（prUrl、attempts 等）。
   */
  setOrchestrationState(
    issueIid: number,
    nextOrchestrationState: OrchestrationState,
    trackerState: IssueState,
    extra?: Partial<IssueRecord>,
  ): void {
    const record = this.get(issueIid);
    if (!record) {
      throw new IssueNotFoundError(issueIid);
    }
    if (record.state === IssueState.Cancelled) return;
    record.orchestrationState = nextOrchestrationState;
    record.state = trackerState;
    record.updatedAt = new Date().toISOString();
    if (trackerState === IssueState.Completed) {
      record.lastError = undefined;
      record.failedAtState = undefined;
    }
    if (extra) {
      Object.assign(record, extra);
    }
    this.store.replace(record);
    eventBus.emitTyped('issue:stateChanged', { issueIid, state: trackerState, record });
  }

  /** 追加一条 phaseHistory 条目（编排核心调用） */
  appendPhaseHistory(issueIid: number, entry: PhaseHistoryEntry): void {
    const record = this.get(issueIid);
    if (!record) return;
    if (!record.phaseHistory) record.phaseHistory = [];
    record.phaseHistory.push(entry);
    record.updatedAt = new Date().toISOString();
    this.store.replace(record);
  }

  /** 清空 phaseHistory（用于 reset / restart） */
  clearPhaseHistory(issueIid: number): void {
    const record = this.get(issueIid);
    if (!record) return;
    record.phaseHistory = undefined;
    record.updatedAt = new Date().toISOString();
    this.store.replace(record);
  }

  /** 初始化阶段进度（流水线启动时调用） */
  initPhaseProgress(issueIid: number, def: PipelineDef): void {
    const record = this.get(issueIid);
    if (!record) return;
    const phases: Record<string, PhaseProgress> = {};
    for (const spec of def.phases) {
      phases[spec.name] = { status: 'pending' };
    }
    record.phaseProgress = phases;
    record.updatedAt = new Date().toISOString();
    this.store.replace(record);
  }

  /** 更新单个阶段的进度（原子保存 + SSE 推送） */
  updatePhaseProgress(issueIid: number, phase: string, update: Partial<PhaseProgress>): void {
    const record = this.get(issueIid);
    if (!record?.phaseProgress) return;
    const pp = record.phaseProgress[phase];
    if (!pp) return;
    Object.assign(pp, update);
    record.updatedAt = new Date().toISOString();
    this.store.replace(record);
    eventBus.emitTyped('issue:stateChanged', { issueIid, state: record.state, record });
  }

  emitFailure(issueIid:number):void {
    const record=this.get(issueIid);
    if(record?.state===IssueState.Failed) eventBus.emitTyped('issue:failed',{issueIid,record,error:record.lastError,failedAtState:record.failedAtState});
  }

  markFailed(issueIid: number, error: string, failedAtState: IssueState, isRetryable?: boolean): void {
    const record = this.get(issueIid);
    if (!record) return;
    if (record.state === IssueState.Cancelled) return;
    record.state = IssueState.Failed;
    record.lastError = error;
    record.failedAtState = failedAtState;
    record.lastErrorRetryable = isRetryable;
    record.attempts += 1;
    record.updatedAt = new Date().toISOString();
    record.orchestrationState = deriveOrchestrationState(record);
    this.store.replace(record);
    logger.warn('Issue marked as failed', { issueIid, error, failedAtState, attempts: record.attempts, isRetryable });
    eventBus.emitTyped('issue:failed', { issueIid, error, failedAtState, record });
  }

  /**
   * Mark as failed WITHOUT incrementing attempts. Used when the agent was still
   * actively producing output at timeout — a slow-but-progressing run should not
   * consume the retry budget.
   */
  markFailedSoft(issueIid: number, error: string, failedAtState: IssueState): void {
    this.markFailed(issueIid, error, failedAtState, true);
  }

  pauseIssue(issueIid: number, currentPhase: string): void {
    const record = this.get(issueIid);
    if (!record) return;
    record.state = IssueState.Paused;
    record.pausedAtPhase = currentPhase;
    record.failedAtState = undefined;
    record.lastError = undefined;
    record.processingLock = undefined;
    record.updatedAt = new Date().toISOString();
    record.orchestrationState = deriveOrchestrationState(record);
    this.store.replace(record);
    logger.info('Issue paused', { issueIid, pausedAtPhase: currentPhase });
    eventBus.emitTyped('issue:paused', { issueIid, pausedAtPhase: currentPhase, record });
  }

  resumeFromPause(issueIid: number, def: PipelineDef, clearSession: boolean): boolean {
    const record = this.get(issueIid);
    if (!record || record.state !== IssueState.Paused || !record.pausedAtPhase) return false;

    const lm = new ActionLifecycleManager(def);
    const preState = lm.getPhasePreState(record.pausedAtPhase);
    if (!preState) return false;

    const phase = record.pausedAtPhase;
    record.state = preState;
    // 设置 currentPhase 为前驱阶段名（与 resetToPhase 逻辑一致）
    if (preState === IssueState.PhaseDone || preState === IssueState.PhaseApproved) {
      const phases = def.phases;
      const idx = phases.findIndex(p => p.name === phase);
      if (idx > 0) {
        record.currentPhase = phases[idx - 1].name;
      }
    }
    record.pausedAtPhase = undefined;
    record.run!.stopIntent = undefined;
    record.updatedAt = new Date().toISOString();
    record.orchestrationState = deriveOrchestrationState(record);
    this.store.replace(record);

    const eventType = clearSession ? 'issue:redone' : 'issue:continued';
    logger.info('Issue resumed from pause', { issueIid, phase, clearSession, state: preState });
    eventBus.emitTyped(eventType, { issueIid, phase, record });
    return true;
  }

  // ── processingLock 管理 ──

  /** 持久化锁超时阈值（默认 30 分钟，与 PHASE_TIMEOUT 一致） */
  private static readonly LOCK_TIMEOUT_MS = 30 * 60 * 1000;

  /**
   * 获取持久化处理锁。
   * - 无锁或超时锁 → 写入并返回 true
   * - 有未超时锁（其他 correlationId）→ 返回 false
   */
  acquireProcessingLock(issueIid: number, correlationId: string): boolean {
    const record = this.get(issueIid);
    if (!record) return false;

    if (record.run!.stopIntent || this.store.isBlocked(issueIid)) return false;
    const existing = record.processingLock;
    if (existing) {
      const age = Date.now() - new Date(existing.ts).getTime();
      if (age < IssueTracker.LOCK_TIMEOUT_MS) {
        logger.warn('Processing lock held, rejecting acquire', {
          issueIid,
          existingCorrelationId: existing.correlationId,
          ageMs: age,
        });
        return false;
      }
      logger.warn('Processing lock timed out, forcibly acquiring', {
        issueIid,
        staleCorrelationId: existing.correlationId,
        ageMs: age,
      });
    }

    record.processingLock = { correlationId, ts: new Date().toISOString() };
    record.updatedAt = new Date().toISOString();
    this.store.replace(record);
    return true;
  }

  /**
   * 释放持久化处理锁。仅当 correlationId 匹配时才清除，防止旧协程误释放新锁。
   */
  releaseProcessingLock(issueIid: number, correlationId: string): void {
    const record = this.get(issueIid);
    if (!record?.processingLock) return;

    if (record.processingLock.correlationId !== correlationId) {
      logger.warn('Processing lock correlationId mismatch, skipping release', {
        issueIid,
        ownCorrelationId: correlationId,
        actualCorrelationId: record.processingLock.correlationId,
      });
      return;
    }

    record.processingLock = undefined;
    record.updatedAt = new Date().toISOString();
    this.store.replace(record);
  }

  /** 强制清除持久化处理锁（管理员操作：restart/cancel/retryFromPhase） */
  clearProcessingLock(issueIid: number): void {
    const record = this.get(issueIid);
    if (!record?.processingLock) return;
    record.processingLock = undefined;
    record.updatedAt = new Date().toISOString();
    this.store.replace(record);
  }

  isProcessing(issueIid: number): boolean {
    const record = this.get(issueIid);
    if (!record) return false;
    return !this.lifecycleFor(record).isTerminal(record.state);
  }

  isCompleted(issueIid: number): boolean {
    const record = this.get(issueIid);
    return record?.state === IssueState.Completed;
  }

  canRetry(issueIid: number, maxRetries: number): boolean {
    const record = this.get(issueIid);
    if (!record || record.state !== IssueState.Failed) return false;
    return record.attempts < maxRetries;
  }

  getRetryState(issueIid: number): IssueState | undefined {
    const record = this.get(issueIid);
    return record?.failedAtState;
  }

  isStalled(issueIid: number, thresholdMs: number = 5 * 60 * 1000): boolean {
    const record = this.get(issueIid);
    if (!record) return false;
    if (this.lifecycleFor(record).isBlocked(record.state)) return false;
    if (!this.isProcessing(issueIid)) return false;
    const elapsed = Date.now() - new Date(record.updatedAt).getTime();
    return elapsed > thresholdMs;
  }

  getDrivableIssues(maxRetries: number, stalledThresholdMs?: number): IssueRecord[] {
    return this.getAllRecords().filter((record) => {
      if (record.run!.stopIntent || this.store.isBlocked(getIssueNumber(record))) return false;
      const lm = this.lifecycleFor(record);
      const drivable = record.run!.recoveryRequired || lm.isDrivable(record.state, record.run!.retryUsed[record.currentPhase ?? 'setup'] ?? 0, maxRetries, record.lastErrorRetryable)
        || this.isStalled(getIssueNumber(record), stalledThresholdMs);
      if (!drivable) return false;

      // 持久化锁检查：有未超时的锁则跳过（正在被某协程处理）
      if (record.processingLock) {
        const age = Date.now() - new Date(record.processingLock.ts).getTime();
        if (age < IssueTracker.LOCK_TIMEOUT_MS) {
          return false;
        }
        // 超时锁不拦截 — 交由 acquireProcessingLock 覆盖
      }

      return true;
    });
  }

  getAllActive(): IssueRecord[] {
    return this.getAllRecords().filter(
      (r) => !this.lifecycleFor(r).isTerminal(r.state),
    );
  }

  getAll(): IssueRecord[] {
    return this.getAllRecords();
  }

  startSkipped(issueIid: number): boolean {
    const record = this.get(issueIid);
    if (!record || record.state !== IssueState.Skipped) return false;
    record.state = IssueState.Pending;
    record.updatedAt = new Date().toISOString();
    record.orchestrationState = deriveOrchestrationState(record);
    this.store.replace(record);
    logger.info('Skipped issue started', { issueIid });
    eventBus.emitTyped('issue:stateChanged', { issueIid, state: IssueState.Pending, record });
    return true;
  }

  resetFull(issueIid: number): boolean {
    const record = this.get(issueIid);
    if (!record) return false;
    record.state = IssueState.Pending;
    record.currentPhase = undefined;
    record.attempts = 0;
    record.failedAtState = undefined;
    record.lastError = undefined;
    record.phaseProgress = undefined;
    record.processingLock = undefined;
    record.resetGeneration = (record.resetGeneration ?? 0) + 1;
    const previous = record.run!;
    record.run = { ...newIssueRun(), version: previous.version, planRevision: previous.planRevision, buildGeneration: previous.buildGeneration + 1, delivery: previous.delivery, workspaces: previous.workspaces, budgetHistory: [...(previous.budgetHistory ?? []), { planRevision: previous.planRevision, buildGeneration: previous.buildGeneration, retryUsed: previous.retryUsed, phaseExecutions: previous.phaseExecutions, repairRounds: previous.repairRounds }] };
    record.run.planDigest = previous.planDigest;
    record.deliveryPending = undefined;record.deliveryNoteWritten = undefined;record.uatRunId = undefined;record.completedAt = undefined;
    record.archivedPhaseHistory = [...(record.archivedPhaseHistory??[]),...(record.phaseHistory??[])];
    record.updatedAt = new Date().toISOString();
    record.phaseHistory = undefined;
    record.orchestrationState = deriveOrchestrationState(record);
    this.store.replace(record);
    logger.info('Issue fully reset', { issueIid });
    eventBus.emitTyped('issue:restarted', { issueIid, record });
    return true;
  }

  resetToPhase(issueIid: number, phase: string, def: PipelineDef): boolean {
    const record = this.get(issueIid);
    if (!record) return false;
    if (!PHASE_IDS.includes(phase as PhaseId) || phase === 'review') return false;
    // Always create a fresh lifecycle manager from the provided def.
    // The cached lifecycleManagers may be stale (e.g., missing dynamically added phases like 'uat').
    const lm = new ActionLifecycleManager(def);
    const targetState = lm.getPhasePreState(phase);
    if (!targetState) return false;
    // 显式回退开始新图执行轮次；暂停继续和失败重试则保留原检查点。
    record.run!.workflow.generation++;
    record.run!.workflow.entry = phase as PhaseId;
    record.state = targetState;
    record.run!.stopIntent = undefined;
    record.deliveryPending=undefined;record.uatRunId=undefined;record.completedAt=undefined;
    // When resetting to a generic phase state, also set currentPhase
    if (targetState === IssueState.PhaseRunning || targetState === IssueState.PhaseDone
        || targetState === IssueState.PhaseWaiting || targetState === IssueState.PhaseApproved) {
      // The phase we're resetting to is the one *before* the given phase (its preState).
      // But since preState is BranchCreated for idx 0 or prev phase's doneState,
      // we need to find the actual phase name that this preState corresponds to.
      // For PhaseDone preState, the currentPhase should be the prev phase name.
      const phases = def.phases;
      const idx = phases.findIndex(p => p.name === phase);
      if (idx > 0) {
        record.currentPhase = phases[idx - 1].name;
      }
    }
    record.failedAtState = undefined;
    record.lastError = undefined;
    record.processingLock = undefined;
    // 重置目标阶段及后续阶段的 phaseProgress
    if (record.phaseProgress) {
      const phaseIdx = def.phases.findIndex(p => p.name === phase);
      if (phaseIdx >= 0) {
        for (let i = phaseIdx; i < def.phases.length; i++) {
          const pp = record.phaseProgress[def.phases[i].name];
          if (pp) {
            pp.status = 'pending';
            pp.startedAt = undefined;
            pp.completedAt = undefined;
            pp.error = undefined;
          }
        }
      }
    }
    record.updatedAt = new Date().toISOString();
    record.orchestrationState = deriveOrchestrationState(record);
    this.store.replace(record);
    logger.info('Issue reset to phase', { issueIid, phase, state: targetState });
    eventBus.emitTyped('issue:retryFromPhase', { issueIid, phase, record });
    return true;
  }

  resetForRetry(issueIid: number): boolean {
    const record = this.get(issueIid);
    if (!record || record.state !== IssueState.Failed) return false;

    const restoreState = record.deliveryPending ? IssueState.Delivering : (record.failedAtState ?? IssueState.Pending);
    if(record.deliveryPending) record.retryCount = (record.retryCount ?? 0) + 1;
    record.state = restoreState;
    record.run!.stopIntent = undefined;
    record.lastError = undefined;
    record.processingLock = undefined;
    // 重置 failed 阶段的 phaseProgress
    if (record.phaseProgress && record.currentPhase) {
      const pp = record.phaseProgress[record.currentPhase];
      if (pp && pp.status === 'failed') {
        pp.status = 'pending';
        pp.startedAt = undefined;
        pp.completedAt = undefined;
        pp.error = undefined;
      }
    }
    record.updatedAt = new Date().toISOString();
    record.orchestrationState = deriveOrchestrationState(record);
    this.store.replace(record);
    logger.info('Issue reset for retry', { issueIid, restoreState });
    eventBus.emitTyped('issue:resetForRetry', { issueIid, restoreState, record });
    return true;
  }

  delete(issueIid: number): boolean {
    const record = this.get(issueIid);
    if (!record || !this.store.delete(issueIid)) return false;
    eventBus.emitTyped('issue:deleted', { issueIid, record });
    return true;
  }

  recoverInterruptedIssues(): number {
    let count = 0;
    for (const record of this.getAllRecords()) {
      if (!this.lifecycleFor(record).isInProgress(record.state) && record.state !== IssueState.Delivering && !record.run!.stopIntent) continue;
      this.transaction(getIssueNumber(record), current => {
        current.run!.recoveryRequired = true;
        current.processingLock = undefined;
        if (current.run!.stopIntent) {
          current.state = current.run!.stopIntent.kind === 'cancel' ? IssueState.Cancelled : IssueState.Paused;
          current.pausedAtPhase = current.currentPhase ?? 'plan';
          current.orchestrationState = deriveOrchestrationState(current);
        }
      });
      count++;
    }
    return count;
  }

  /** 将所有 IssueRecord 投影为 ExecutableTask[] */
  toExecutableTasks(): ExecutableTask[] {
    return this.getAllRecords().map((record) => {
      const lm = this.lifecycleFor(record);
      return issueToExecutableTask(record, lm);
    });
  }
}
