import { describe, expect, it } from 'vitest';
import { resolveVisualGaps } from '../../src/e2e/UatOutcome.js';
import type { VisualCoverageGap, VisualReviewResult } from '../../src/shared/workbench.js';

const gap = (description: string): VisualCoverageGap => ({
  kind: 'missing-visible-state', description, acceptanceRefs: ['plan:0'], screenshotIds: [],
});
const first = gap('加载状态');
const second = gap('空列表状态');
const result: VisualReviewResult = {
  status: 'needs-review', summary: '存在覆盖缺口', reasonCode: 'visual-coverage-gaps',
  issues: [], selectedScreenshots: ['image-1'], checkedScreenshots: ['image-1'],
  unreviewedScreenshots: [], coverageGaps: [first.description, second.description],
  coverageGapDetails: [first, second],
};

describe('视觉覆盖缺口消解', () => {
  it('只覆盖部分缺口时仍需复核，并把剩余缺口关联到本轮运行', () => {
    const resolved = resolveVisualGaps(result, [first], 'current-run');
    expect(resolved.status).toBe('needs-review');
    expect(resolved.coverageGapDetails).toEqual([
      { ...second, gapIndex: 0, sourceRunId: 'current-run' },
    ]);
  });

  it('全部缺口由当前行为测试覆盖后通过', () => {
    expect(resolveVisualGaps(result, [first, second], 'current-run')).toMatchObject({
      status: 'passed', coverageGaps: [], coverageGapDetails: [],
    });
  });

  it.each([
    { unreviewedScreenshots: ['image-2'] },
    { reasonCode: 'visual-review-incomplete' },
    { reasonCode: 'uat-visual-review-environment' },
  ])('消除缺口不掩盖其他复核失败：%j', (otherFailure) => {
    expect(resolveVisualGaps({ ...result, ...otherFailure }, [first, second], 'current-run')
      .status).toBe('needs-review');
  });
});
