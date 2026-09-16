import { describe, it, expect } from 'vitest';
import { computeReviewGateStatus } from '../../src/web/frontend/src/utils/reviewGateStatus.js';

/**
 * 回归测试：Bug 2 — ReviewGatePanel 在 release/uat gate 时不应渲染 "waiting"
 *
 * 历史 bug：ReviewGatePanel 计算 reviewStatus 时只判断 state === 'phase_waiting'，
 * 不区分 currentPhase。当 issue 处于 release-gate 的 PhaseWaiting 时（如 verify
 * 失败后被错误地跳到 release detect 并触发 gate），前端会错误地渲染"批准/驳回"
 * 按钮，诱导用户做出针对 release-gate 的"批准 plan"操作，进一步触发后端 Bug 3。
 *
 * 修复要求：仅当 currentPhase 严格等于 gate phase 名时才返回 'waiting'。
 */

describe('computeReviewGateStatus (Bug 2 regression)', () => {
  describe('PhaseWaiting + currentPhase', () => {
    it('returns "waiting" only when currentPhase matches review gate', () => {
      expect(computeReviewGateStatus('phase_waiting', 'review', 'review', 0)).toBe('waiting');
    });

    it('does NOT return "waiting" when currentPhase is "release" (Bug 2 regression)', () => {
      // 关键：release-gate 的 PhaseWaiting 不应触发 review 面板的 "waiting" 状态。
      // 否则用户会误点"批准 plan"按钮。
      const status = computeReviewGateStatus('phase_waiting', 'release', 'review', 0);
      expect(status).not.toBe('waiting');
      // 由于已经越过 review，应视为 review 已通过（approved）
      expect(status).toBe('approved');
    });

    it('does NOT return "waiting" when currentPhase is "uat" (Bug 2 regression)', () => {
      const status = computeReviewGateStatus('phase_waiting', 'uat', 'review', 0);
      expect(status).not.toBe('waiting');
      expect(status).toBe('approved');
    });

    it('does NOT return "waiting" when currentPhase is undefined (defensive)', () => {
      // 不应当把"未知阶段"当作 review 的 waiting，避免误判。
      const status = computeReviewGateStatus('phase_waiting', undefined, 'review', 0);
      expect(status).not.toBe('waiting');
    });
  });

  describe('Custom gate phase name (跨流水线扩展)', () => {
    it('respects custom gate phase name via the gatePhaseName param', () => {
      // 如果未来某个流水线把 gate 阶段叫 'approval'，该函数必须按传入的名字判断
      expect(computeReviewGateStatus('phase_waiting', 'approval', 'approval', 0)).toBe('waiting');
      expect(computeReviewGateStatus('phase_waiting', 'review', 'approval', 0)).toBe('approved');
    });
  });

  describe('Other states', () => {
    it('returns "approved" for phase_approved', () => {
      expect(computeReviewGateStatus('phase_approved', 'review', 'review', 0)).toBe('approved');
    });

    it('Native ready 投影只在存在审核凭证时视为通过', () => {
      expect(computeReviewGateStatus('branch_created', undefined, 'review', 0, 'approved')).toBe('approved');
      expect(computeReviewGateStatus('branch_created', undefined, 'review', 0)).toBe('not_started');
    });

    it('returns "approved" for completed', () => {
      expect(computeReviewGateStatus('completed', 'verify', 'review', 0)).toBe('approved');
    });

    it('returns "approved" for deployed', () => {
    });

    it('returns "approved" for resolving_conflict', () => {
      expect(computeReviewGateStatus('resolving_conflict', undefined, 'review', 0)).toBe('approved');
    });

    it('returns "approved" for phase_running + post-review phase (e.g. build)', () => {
      expect(computeReviewGateStatus('phase_running', 'build', 'review', 0)).toBe('approved');
    });

    it('returns "approved" for phase_done + verify (在 verify 阶段后)', () => {
      expect(computeReviewGateStatus('phase_done', 'verify', 'review', 0)).toBe('approved');
    });

    it('已删除的发布阶段不能推导审核通过', () => {
      expect(computeReviewGateStatus('failed', 'release', 'review', 0)).toBe('not_started');
    });

    it('returns "replanning" when review history exists and no other approved signal', () => {
      // plan re-running 中（state=phase_running + currentPhase=plan），但有历史驳回反馈
      expect(computeReviewGateStatus('phase_running', 'plan', 'review', 2)).toBe('replanning');
    });

    it('returns "not_started" when no history and no review signal', () => {
      expect(computeReviewGateStatus('pending', undefined, 'review', 0)).toBe('not_started');
      expect(computeReviewGateStatus('branch_created', undefined, 'review', 0)).toBe('not_started');
    });
  });

  describe('Full state matrix (regression safety)', () => {
    // 显式列出所有 (state, currentPhase) 组合，确保没有意外回归
    const cases: Array<{ state: string; phase?: string; history: number; expected: string; note?: string }> = [
      // ▼ Bug 2 修复点的核心 case ▼
      { state: 'phase_waiting', phase: 'review', history: 0, expected: 'waiting' },
      { state: 'phase_waiting', phase: 'release', history: 0, expected: 'approved', note: 'Bug 2 fix' },
      { state: 'phase_waiting', phase: 'uat', history: 0, expected: 'approved', note: 'Bug 2 fix' },
      { state: 'phase_waiting', phase: undefined, history: 0, expected: 'approved', note: 'Bug 2 fix' },
      // phase_approved 状态
      { state: 'phase_approved', phase: 'review', history: 0, expected: 'approved' },
      { state: 'phase_approved', phase: 'release', history: 0, expected: 'approved' },
      // 终态
      { state: 'completed', phase: 'verify', history: 5, expected: 'approved' },
      // 后置阶段进行中
      { state: 'phase_running', phase: 'build', history: 0, expected: 'approved' },
      { state: 'phase_running', phase: 'verify', history: 3, expected: 'approved' },
      { state: 'phase_running', phase: 'release', history: 0, expected: 'not_started' },
      { state: 'phase_running', phase: 'uat', history: 0, expected: 'approved' },
      // 流水线在 plan 阶段重跑（review 被驳回过）
      { state: 'phase_running', phase: 'plan', history: 1, expected: 'replanning' },
      { state: 'phase_done', phase: 'plan', history: 2, expected: 'replanning' },
      // 全新流水线尚未开始
      { state: 'pending', phase: undefined, history: 0, expected: 'not_started' },
      { state: 'branch_created', phase: undefined, history: 0, expected: 'not_started' },
    ];

    for (const c of cases) {
      const tag = c.note ? ` [${c.note}]` : '';
      it(`(${c.state}, ${c.phase ?? 'undefined'}, history=${c.history}) → ${c.expected}${tag}`, () => {
        expect(
          computeReviewGateStatus(c.state as never, c.phase, 'review', c.history),
        ).toBe(c.expected);
      });
    }
  });
});
