import type { IssueState } from '../types';

export type ReviewGateStatus = 'not_started' | 'waiting' | 'approved' | 'replanning';

/**
 * Issue 处于这些状态时，review gate 一定已经通过（终态 / 后置 gate / 冲突修复中）。
 */
const POST_REVIEW_STATES: ReadonlySet<string> = new Set([
  'phase_approved', 'completed', 'resolving_conflict',
]);

/**
 * 这些阶段名出现在 currentPhase 上时，说明流水线已越过了 review gate。
 * 用于推导 review 已通过的状态（即使主 state 是 phase_running/phase_done 等）。
 */
const POST_REVIEW_PHASES: ReadonlySet<string> = new Set(['build', 'verify', 'uat']);


export function computeReviewGateStatus(
  state: IssueState | undefined,
  currentPhase: string | undefined,
  gatePhaseName: string,
  reviewHistoryLength: number,
  reviewDecision?: 'waiting' | 'approved' | 'rejected',
): ReviewGateStatus {
  // Native 的 ready 是通用调度状态；审核结果必须读取明确的业务凭证，不能由 ready/branch_created 猜测。
  if (reviewDecision === 'approved') return 'approved';

  // 仅当 PhaseWaiting + currentPhase 与 gate phase 严格一致时，才视为待审核。
  if (state === 'phase_waiting' && currentPhase === gatePhaseName) {
    return 'waiting';
  }


  // 说明已越过 review，由对应阶段面板负责展示，这里视为 review 已通过。
  if (state === 'phase_waiting') {
    return 'approved';
  }

  if (POST_REVIEW_STATES.has(state ?? '')) {
    return 'approved';
  }

  if ((state === 'phase_running' || state === 'phase_done' || state === 'failed' || state === 'paused')
      && currentPhase && POST_REVIEW_PHASES.has(currentPhase)) {
    return 'approved';
  }

  if (reviewHistoryLength > 0) return 'replanning';
  return 'not_started';
}
