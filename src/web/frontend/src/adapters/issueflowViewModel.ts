import type { IssueLifecycle, IssueRecord } from '@/types';

export type AllowedAction =
  | 'start'
  | 'retry'
  | 'abort'
  | 'continue'
  | 'redo-phase'
  | 'restart'
  | 'cancel'
  | 'stop-preview'
  | 'restart-preview';

/** 只有处于审核阶段的 waiting 生命周期才算“待审核”。暂停属于可恢复状态。 */
export function isReviewWaiting(lifecycle: IssueLifecycle): boolean {
  return lifecycle.kind === 'waiting' && lifecycle.phase === 'review';
}

/** 失败和暂停需要提供恢复入口，不受计划审核阶段限制。 */
export function needsIntervention(lifecycle: IssueLifecycle): boolean {
  return lifecycle.kind === 'failed' || lifecycle.kind === 'paused';
}

/**
 * 由服务端生命周期和当前运行配置计算操作入口。
 * 页面只消费这个结果，不根据按钮文案自行推断业务状态。
 */
export function getAllowedActions(record: IssueRecord): AllowedAction[] {
  const kind = record.lifecycle.kind;
  const actions: AllowedAction[] = [];
  if (kind === 'skipped') actions.push('start');
  if (kind === 'failed') actions.push('retry');
  if (kind === 'running' || kind === 'waiting' || kind === 'ready') actions.push('abort');
  if (kind === 'paused') actions.push('continue', 'redo-phase');
  if (kind !== 'skipped') actions.push('restart');
  if (record.preview?.running) actions.push('stop-preview');
  else if (!['pending', 'skipped'].includes(kind)) actions.push('restart-preview');
  if (kind !== 'completed' && kind !== 'cancelled') actions.push('cancel');
  return actions;
}
