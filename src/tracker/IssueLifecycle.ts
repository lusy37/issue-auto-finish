import type { PhaseError } from '../orchestration/PhaseResult.js';
import { PHASE_IDS, type PhaseId } from '../orchestration/WorkflowState.js';
import type { IssueRecord } from './IssueRecord.js';

/** 调度、人工介入和交付使用的唯一业务生命周期。 */
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

/** 持久化边界的最小结构校验；跨字段业务规则由 invariant 函数负责。 */
export function assertIssueLifecycleShape(value: unknown): asserts value is IssueLifecycle {
  if (!value || typeof value !== 'object' || !('kind' in value))
    throw new Error('业务生命周期缺失或无效');
  const lifecycle = value as Record<string, unknown>;
  const kind = lifecycle.kind;
  if (
    ![
      'pending',
      'skipped',
      'ready',
      'running',
      'waiting',
      'paused',
      'failed',
      'delivering',
      'completed',
      'cancelled',
    ].includes(String(kind))
  ) {
    throw new Error('业务生命周期缺失或无效');
  }
  if (
    ['running', 'waiting', 'paused'].includes(String(kind)) &&
    (typeof lifecycle.phase !== 'string' || !PHASE_IDS.includes(lifecycle.phase as PhaseId))
  ) {
    throw new Error('业务生命周期阶段无效');
  }
  if (
    kind === 'waiting' &&
    lifecycle.planRevision !== undefined &&
    (!Number.isInteger(lifecycle.planRevision) || Number(lifecycle.planRevision) <= 0)
  ) {
    throw new Error('等待状态的计划版本无效');
  }
  if (kind === 'failed') {
    const error = lifecycle.error as Record<string, unknown> | undefined;
    if (
      !['auto', 'manual'].includes(String(lifecycle.retry)) ||
      !error ||
      typeof error.message !== 'string'
    ) {
      throw new Error('失败生命周期缺少错误或重试策略');
    }
    if (
      lifecycle.phase !== undefined &&
      (typeof lifecycle.phase !== 'string' || !PHASE_IDS.includes(lifecycle.phase as PhaseId))
    ) {
      throw new Error('失败生命周期阶段无效');
    }
  }
}

/** 校验生命周期事件，不参与计算 LangGraph 下一节点。 */
// 生命周期说明与完整转换表见 docs/issue-lifecycle.md；此处不决定图的执行位置。
export function reduceIssueLifecycle(
  current: IssueLifecycle,
  event: IssueLifecycleEvent,
): IssueLifecycle {
  switch (event.type) {
    case 'setup-completed':
      if (current.kind === 'pending' || current.kind === 'ready') return { kind: 'ready' };
      break;
    case 'start-requested':
      if (current.kind === 'skipped') return { kind: 'pending' };
      break;
    case 'phase-started':
      if (
        current.kind === 'ready' ||
        current.kind === 'pending' ||
        (current.kind === 'failed' &&
          current.retry === 'auto' &&
          (!current.phase || current.phase === event.phase))
      ) {
        return { kind: 'running', phase: event.phase };
      }
      break;
    case 'phase-completed':
      if (current.kind === 'running' && current.phase === event.phase) return { kind: 'ready' };
      break;
    case 'gate-interrupted':
      if (current.kind === 'waiting' && current.phase === event.phase) {
        if (
          current.phase === 'review' &&
          current.planRevision !== undefined &&
          event.planRevision !== undefined &&
          current.planRevision !== event.planRevision
        )
          break;
        return current;
      }
      if (current.kind === 'running' && current.phase === event.phase) {
        return { kind: 'waiting', phase: event.phase, planRevision: event.planRevision };
      }
      break;
    case 'gate-resolved':
      if (
        (current.kind === 'waiting' || current.kind === 'running') &&
        current.phase === event.phase
      ) {
        if (
          current.kind === 'waiting' &&
          current.phase === 'review' &&
          current.planRevision !== event.planRevision
        ) {
          throw new InvalidLifecycleTransitionError(current, event, '审核计划版本或等待状态已改变');
        }
        return event.action === 'approve' ? { kind: 'ready' } : { kind: 'pending' };
      }
      break;
    case 'phase-failed':
      if (
        ['pending', 'ready', 'running', 'failed', 'delivering'].includes(current.kind) &&
        !(current.kind === 'running' && event.phase && current.phase !== event.phase)
      ) {
        return { kind: 'failed', phase: event.phase, retry: event.retry, error: event.error };
      }
      break;
    case 'pause-requested':
      if (
        ['pending', 'ready', 'running', 'waiting', 'failed', 'delivering'].includes(current.kind)
      ) {
        return { kind: 'paused', phase: event.phase };
      }
      break;
    case 'continue-requested':
      if (current.kind === 'paused') return { kind: 'ready' };
      break;
    case 'retry-requested':
      if (current.kind === 'failed') return { kind: 'ready' };
      break;
    case 'phase-redo-requested':
      if (current.kind !== 'cancelled') return { kind: 'ready' };
      break;
    case 'delivery-started':
      if (current.kind === 'ready' || current.kind === 'running') return { kind: 'delivering' };
      break;
    case 'delivery-confirmed':
      if (current.kind === 'delivering') return { kind: 'completed' };
      break;
    case 'cancel-requested':
      if (current.kind !== 'completed' && current.kind !== 'cancelled')
        return { kind: 'cancelled' };
      break;
    case 'full-redo-requested':
      return { kind: 'pending' };
    case 'conflict-repair-started':
      if (current.kind === 'completed') return { kind: 'ready' };
      break;
  }
  throw new InvalidLifecycleTransitionError(current, event);
}

export function applyIssueLifecycleEvent(
  record: IssueRecord,
  event: IssueLifecycleEvent,
): IssueLifecycle {
  const next = reduceIssueLifecycle(record.lifecycle, event);
  record.lifecycle = structuredClone(next);
  return next;
}

export function isLifecycleSchedulable(lifecycle: IssueLifecycle): boolean {
  return (
    lifecycle.kind === 'pending' ||
    lifecycle.kind === 'ready' ||
    (lifecycle.kind === 'failed' && lifecycle.retry === 'auto')
  );
}

export function assertReviewInvariant(record: IssueRecord): void {
  const lifecycle = record.lifecycle;
  if (lifecycle.kind !== 'waiting' || lifecycle.phase !== 'review') return;
  if (
    lifecycle.planRevision === undefined ||
    lifecycle.planRevision !== record.run.planRevision ||
    record.run.review?.decision !== 'waiting'
  ) {
    throw new Error('Review 等待状态与计划版本不一致');
  }
}
