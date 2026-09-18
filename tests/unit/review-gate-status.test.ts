import { describe, expect, it } from 'vitest';
import { computeReviewGateStatus } from '../../src/web/frontend/src/utils/reviewGateStatus.js';
import type { IssueLifecycle } from '../../src/web/frontend/src/types/index.js';

describe('computeReviewGateStatus', () => {
  it('仅将当前审核 gate 识别为等待审核', () => {
    expect(computeReviewGateStatus({ kind: 'waiting', phase: 'review' }, 'review', 0)).toBe('waiting');
    expect(computeReviewGateStatus({ kind: 'waiting', phase: 'uat' }, 'review', 0)).toBe('approved');
  });

  it('支持自定义 gate 名称', () => {
    const lifecycle = { kind: 'waiting', phase: 'approval' } as unknown as IssueLifecycle;
    expect(computeReviewGateStatus(lifecycle, 'approval', 0)).toBe('waiting');
    expect(computeReviewGateStatus(lifecycle, 'review', 0)).toBe('approved');
  });

  it('已批准凭证优先于生命周期投影', () => {
    expect(computeReviewGateStatus({ kind: 'ready' }, 'review', 0, 'approved')).toBe('approved');
  });

  it.each<IssueLifecycle>([
    { kind: 'running', phase: 'build' },
    { kind: 'running', phase: 'verify' },
    { kind: 'running', phase: 'uat' },
    { kind: 'delivering' },
    { kind: 'completed' },
  ])('审核后生命周期 $kind 视为已批准', lifecycle => {
    expect(computeReviewGateStatus(lifecycle, 'review', 0)).toBe('approved');
  });

  it('存在驳回历史且尚无批准信号时显示重新规划', () => {
    expect(computeReviewGateStatus({ kind: 'running', phase: 'plan' }, 'review', 2)).toBe('replanning');
  });

  it.each<IssueLifecycle | undefined>([
    undefined,
    { kind: 'pending' },
    { kind: 'ready' },
    { kind: 'running', phase: 'plan' },
  ])('没有审核信号时返回未开始', lifecycle => {
    expect(computeReviewGateStatus(lifecycle, 'review', 0)).toBe('not_started');
  });
});
