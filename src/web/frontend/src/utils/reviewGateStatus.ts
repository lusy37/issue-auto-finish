import type { IssueLifecycle } from '../types';

export type ReviewGateStatus = 'not_started' | 'waiting' | 'approved' | 'replanning';

const POST_REVIEW_PHASES: ReadonlySet<string> = new Set(['build', 'verify', 'uat']);

export function computeReviewGateStatus(
  lifecycle: IssueLifecycle | undefined,
  gatePhaseName: string,
  reviewHistoryLength: number,
  reviewDecision?: 'waiting' | 'approved' | 'rejected',
): ReviewGateStatus {
  if (reviewDecision === 'approved') return 'approved';
  if (lifecycle?.kind === 'waiting' && lifecycle.phase === gatePhaseName) return 'waiting';
  if (lifecycle?.kind === 'waiting') return 'approved';
  if (lifecycle?.kind === 'completed' || lifecycle?.kind === 'delivering') return 'approved';
  if (lifecycle && 'phase' in lifecycle && lifecycle.phase && POST_REVIEW_PHASES.has(lifecycle.phase)) return 'approved';
  if (reviewHistoryLength > 0) return 'replanning';
  return 'not_started';
}
