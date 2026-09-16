import type { PhaseError } from '../orchestration/PhaseResult.js';
import { PHASE_IDS, type PhaseId } from '../orchestration/WorkflowState.js';
import { IssueState, deriveOrchestrationState, type IssueRecord } from './IssueState.js';

/**
 * Issue 顶层业务生命周期。
 *
 * 它只表达调度、人工介入和交付生命周期；LangGraph checkpoint 仍是执行位置的唯一依据。
 */
export type IssueLifecycle =
  | { kind: 'pending' }
  | { kind: 'skipped' }
  | { kind: 'ready' }
  | { kind: 'running'; phase: PhaseId }
  | { kind: 'waiting'; phase: PhaseId; planRevision?: number }
  | { kind: 'paused'; phase: PhaseId }
  | { kind: 'failed'; phase?: PhaseId; retry: 'auto' | 'manual'; error: PhaseError }
  | { kind: 'delivering' }
  | { kind: 'completed' }
  | { kind: 'cancelled' };

export type IssueLifecycleEvent =
  | { type: 'setup-completed' }
  | { type: 'start-requested' }
  | { type: 'phase-started'; phase: PhaseId }
  | { type: 'phase-completed'; phase: PhaseId }
  | { type: 'gate-interrupted'; phase: PhaseId; planRevision?: number }
  | { type: 'gate-resolved'; phase: PhaseId; action: 'approve' | 'reject'; planRevision?: number }
  | { type: 'phase-failed'; phase?: PhaseId; retry: 'auto' | 'manual'; error: PhaseError }
  | { type: 'pause-requested'; phase: PhaseId }
  | { type: 'continue-requested' }
  | { type: 'retry-requested' }
  | { type: 'phase-redo-requested' }
  | { type: 'delivery-started' }
  | { type: 'delivery-confirmed' }
  | { type: 'cancel-requested' }
  | { type: 'full-redo-requested' }
  | { type: 'conflict-repair-started' };

export class InvalidLifecycleTransitionError extends Error {
  constructor(current: IssueLifecycle, event: IssueLifecycleEvent, reason?: string) {
    super(reason ?? `非法生命周期转换：${current.kind} -> ${event.type}`);
    this.name = 'InvalidLifecycleTransitionError';
  }
}

/** 持久化边界的最小结构校验；跨字段业务规则由专用 invariant 函数负责。 */
export function assertIssueLifecycleShape(value: unknown): asserts value is IssueLifecycle {
  if (!value || typeof value !== 'object' || !('kind' in value)) throw new Error('业务生命周期缺失或无效');
  const lifecycle = value as Record<string, unknown>;
  const kind = lifecycle.kind;
  if (!['pending', 'skipped', 'ready', 'running', 'waiting', 'paused', 'failed', 'delivering', 'completed', 'cancelled'].includes(String(kind))) {
    throw new Error('业务生命周期缺失或无效');
  }
  if (['running', 'waiting', 'paused'].includes(String(kind))
    && (typeof lifecycle.phase !== 'string' || !PHASE_IDS.includes(lifecycle.phase as PhaseId))) {
    throw new Error('业务生命周期阶段无效');
  }
  if (kind === 'waiting' && lifecycle.planRevision !== undefined
    && (!Number.isInteger(lifecycle.planRevision) || Number(lifecycle.planRevision) <= 0)) {
    throw new Error('等待状态的计划版本无效');
  }
  if (kind === 'failed') {
    const error = lifecycle.error as Record<string, unknown> | undefined;
    if (!['auto', 'manual'].includes(String(lifecycle.retry)) || !error || typeof error.message !== 'string') {
      throw new Error('失败生命周期缺少错误或重试策略');
    }
    if (lifecycle.phase !== undefined
      && (typeof lifecycle.phase !== 'string' || !PHASE_IDS.includes(lifecycle.phase as PhaseId))) {
      throw new Error('失败生命周期阶段无效');
    }
  }
}

function phaseId(value: string | undefined, fallback?: PhaseId): PhaseId {
  if (value && PHASE_IDS.includes(value as PhaseId)) return value as PhaseId;
  if (fallback) return fallback;
  throw new Error(`阶段 ID 无效：${value ?? '<empty>'}`);
}

/** 读取唯一持久化的业务生命周期。 */
export function readIssueLifecycle(record: IssueRecord): IssueLifecycle {
  return structuredClone(record.lifecycle);
}

/** 仅供新记录和 v3 REST 兼容入口使用，不参与 v4 文件迁移。 */
export function lifecycleFromLegacyProjection(record: Pick<IssueRecord,
  'state' | 'currentPhase' | 'pausedAtPhase' | 'lastError' | 'lastErrorRetryable' | 'run'>): IssueLifecycle {
  switch (record.state) {
    case IssueState.Pending:
      return { kind: 'pending' };
    case IssueState.Skipped:
      return { kind: 'skipped' };
    case IssueState.BranchCreated:
    case IssueState.PhaseDone:
    case IssueState.PhaseApproved:
    case IssueState.ResolvingConflict:
      return { kind: 'ready' };
    case IssueState.PhaseRunning:
      // v3 曾允许只写 PhaseRunning 而未写 currentPhase；适配期按首阶段读取，
      // v4 Codec 会在持久化边界拒绝这种不完整组合。
      return { kind: 'running', phase: phaseId(record.currentPhase, 'plan') };
    case IssueState.PhaseWaiting: {
      const phase = phaseId(record.currentPhase, 'review');
      return {
        kind: 'waiting',
        phase,
        ...(phase === 'review' && record.run?.planRevision
          ? { planRevision: record.run.planRevision }
          : {}),
      };
    }
    case IssueState.Paused:
      return {
        kind: 'paused',
        phase: phaseId(record.pausedAtPhase ?? record.currentPhase, 'plan'),
      };
    case IssueState.Failed:
      return {
        kind: 'failed',
        ...(record.currentPhase && PHASE_IDS.includes(record.currentPhase as PhaseId)
          ? { phase: record.currentPhase as PhaseId }
          : {}),
        retry: record.lastErrorRetryable === false ? 'manual' : 'auto',
        error: {
          message: record.lastError ?? '任务执行失败',
          retryable: record.lastErrorRetryable === false ? 'hard-no-auto' : 'hard',
        },
      };
    case IssueState.Delivering:
      return { kind: 'delivering' };
    case IssueState.Completed:
      return { kind: 'completed' };
    case IssueState.Cancelled:
      return { kind: 'cancelled' };
  }
}

/** 只验证生命周期序列，不推导 LangGraph 下一节点。 */
export function reduceIssueLifecycle(
  current: IssueLifecycle,
  event: IssueLifecycleEvent,
): IssueLifecycle {
  switch (event.type) {
    case 'setup-completed':
      if (current.kind !== 'pending' && current.kind !== 'ready') break;
      return { kind: 'ready' };
    case 'start-requested':
      if (current.kind !== 'skipped') break;
      return { kind: 'pending' };
    case 'phase-started':
      if (current.kind !== 'ready'
        && current.kind !== 'pending'
        && !(current.kind === 'failed'
          && current.retry === 'auto'
          && (!current.phase || current.phase === event.phase))) break;
      return { kind: 'running', phase: event.phase };
    case 'phase-completed':
      if (current.kind !== 'running' || current.phase !== event.phase) break;
      return { kind: 'ready' };
    case 'gate-interrupted':
      if (current.kind === 'waiting' && current.phase === event.phase) {
        if (current.phase === 'review'
          && current.planRevision !== undefined
          && event.planRevision !== undefined
          && current.planRevision !== event.planRevision) break;
        return current;
      }
      if (current.kind !== 'running' || current.phase !== event.phase) break;
      return { kind: 'waiting', phase: event.phase, planRevision: event.planRevision };
    case 'gate-resolved':
      if ((current.kind !== 'waiting' && current.kind !== 'running') || current.phase !== event.phase) break;
      if (current.kind === 'waiting' && current.phase === 'review' && current.planRevision !== event.planRevision) {
        throw new InvalidLifecycleTransitionError(current, event, '审核计划版本或等待状态已改变');
      }
      return event.action === 'approve' ? { kind: 'ready' } : { kind: 'pending' };
    case 'phase-failed':
      if (!['pending', 'ready', 'running', 'failed', 'delivering'].includes(current.kind)) break;
      if (current.kind === 'running' && event.phase && current.phase !== event.phase) break;
      return { kind: 'failed', phase: event.phase, retry: event.retry, error: event.error };
    case 'pause-requested':
      if (!['pending', 'ready', 'running', 'waiting', 'failed', 'delivering'].includes(current.kind)) break;
      return { kind: 'paused', phase: event.phase };
    case 'continue-requested':
      if (current.kind !== 'paused') break;
      return { kind: 'ready' };
    case 'retry-requested':
      if (current.kind !== 'failed') break;
      return { kind: 'ready' };
    case 'phase-redo-requested':
      if (current.kind === 'cancelled') break;
      return { kind: 'ready' };
    case 'delivery-started':
      if (current.kind !== 'ready' && current.kind !== 'running') break;
      return { kind: 'delivering' };
    case 'delivery-confirmed':
      if (current.kind !== 'delivering') break;
      return { kind: 'completed' };
    case 'cancel-requested':
      if (current.kind === 'completed' || current.kind === 'cancelled') break;
      return { kind: 'cancelled' };
    case 'full-redo-requested':
      return { kind: 'pending' };
    case 'conflict-repair-started':
      if (current.kind !== 'completed') break;
      return { kind: 'ready' };
  }
  throw new InvalidLifecycleTransitionError(current, event);
}

/** REST 兼容层使用的重试次数投影，不参与调度判断。 */
export function projectRetryAttempts(record: Pick<IssueRecord, 'run' | 'retryCount'>): number {
  const current = Object.values(record.run?.retryUsed ?? {}).reduce((sum, value) => sum + value, 0);
  return Math.max(record.retryCount ?? 0, current);
}

/** 从唯一生命周期生成 v3 REST 兼容字段；这些字段不会写入 run.json。 */
export function syncLegacyIssueProjection(record: IssueRecord): void {
  const lifecycle = record.lifecycle;
  record.lastError = undefined;
  record.lastErrorRetryable = undefined;
  record.failedAtState = undefined;
  record.currentPhase = undefined;
  record.pausedAtPhase = undefined;
  record.attempts = projectRetryAttempts(record);
  switch (lifecycle.kind) {
    case 'pending':
      record.state = IssueState.Pending;
      record.currentPhase = undefined;
      record.pausedAtPhase = undefined;
      break;
    case 'skipped':
      record.state = IssueState.Skipped;
      record.currentPhase = undefined;
      record.pausedAtPhase = undefined;
      break;
    case 'ready':
      record.state = IssueState.BranchCreated;
      break;
    case 'running':
      record.state = IssueState.PhaseRunning;
      record.currentPhase = lifecycle.phase;
      record.pausedAtPhase = undefined;
      break;
    case 'waiting':
      record.state = IssueState.PhaseWaiting;
      record.currentPhase = lifecycle.phase;
      record.pausedAtPhase = undefined;
      break;
    case 'paused':
      record.state = IssueState.Paused;
      record.currentPhase = lifecycle.phase;
      record.pausedAtPhase = lifecycle.phase;
      break;
    case 'failed':
      record.state = IssueState.Failed;
      record.currentPhase = lifecycle.phase;
      record.lastError = lifecycle.error.message;
      record.lastErrorRetryable = lifecycle.retry === 'auto';
      record.failedAtState = IssueState.PhaseRunning;
      break;
    case 'delivering':
      record.state = IssueState.Delivering;
      record.deliveryPending = true;
      break;
    case 'completed':
      record.state = IssueState.Completed;
      record.deliveryPending = false;
      break;
    case 'cancelled':
      record.state = IssueState.Cancelled;
      break;
  }
  record.orchestrationState = deriveOrchestrationState(record);
  if (lifecycle.kind === 'waiting' && lifecycle.planRevision !== undefined) {
    record.orchestrationState = {
      kind: 'gate-waiting',
      phaseId: lifecycle.phase,
      reason: lifecycle.phase === 'review' ? 'human-review' : 'custom',
      payload: { planRevision: lifecycle.planRevision },
    };
  } else if (lifecycle.kind === 'failed') {
    record.orchestrationState = {
      kind: 'pipeline-failed',
      failedAt: lifecycle.phase ?? '',
      retryable: lifecycle.retry,
      error: lifecycle.error,
    };
  }
}

/** 写入唯一生命周期，并立即刷新只读兼容投影。 */
export function writeIssueLifecycle(record: IssueRecord, lifecycle: IssueLifecycle): void {
  record.lifecycle = structuredClone(lifecycle);
  syncLegacyIssueProjection(record);
}

/**
 * 兼容旧调用方在事务内直接赋值 state/currentPhase。
 * v4 磁盘从不保存这些字段；若兼容投影被改动，则在事务提交前单向翻译为 lifecycle。
 */
export function reconcileLegacyIssueProjection(
  record: IssueRecord,
  lifecycleBeforeUpdate?: IssueLifecycle,
): void {
  // 同一事务已经通过生命周期事件完成权威写入时，不允许随后生成的旧 API
  // 投影再反向覆盖它（例如丢失 waiting.planRevision）。
  if (lifecycleBeforeUpdate
    && JSON.stringify(record.lifecycle) !== JSON.stringify(lifecycleBeforeUpdate)) {
    syncLegacyIssueProjection(record);
    return;
  }
  const candidate = lifecycleFromLegacyProjection(record);
  if (JSON.stringify(candidate) !== JSON.stringify(record.lifecycle)) {
    writeIssueLifecycle(record, candidate);
  }
}

export function applyIssueLifecycleEvent(
  record: IssueRecord,
  event: IssueLifecycleEvent,
): IssueLifecycle {
  const next = reduceIssueLifecycle(readIssueLifecycle(record), event);
  writeIssueLifecycle(record, next);
  // v3 API 仍对外暴露审核专用枚举；兼容投影集中保留在适配器中，
  // 生命周期本身只表达 ready / pending，不重新引入一套业务状态。
  if (event.type === 'gate-resolved') {
    record.state = event.action === 'approve' ? IssueState.PhaseApproved : IssueState.Pending;
    if (event.action === 'reject') record.currentPhase = undefined;
    record.orchestrationState = deriveOrchestrationState(record);
  }
  return next;
}

export function isLifecycleSchedulable(lifecycle: IssueLifecycle): boolean {
  return lifecycle.kind === 'pending'
    || lifecycle.kind === 'ready'
    || (lifecycle.kind === 'failed' && lifecycle.retry === 'auto');
}

export function assertReviewInvariant(record: IssueRecord): void {
  const lifecycle = readIssueLifecycle(record);
  if (lifecycle.kind !== 'waiting' || lifecycle.phase !== 'review') return;
  if (lifecycle.planRevision === undefined
    || lifecycle.planRevision !== record.run!.planRevision
    || record.run!.review?.decision !== 'waiting') {
    throw new Error('Review 等待状态与计划版本不一致');
  }
}
