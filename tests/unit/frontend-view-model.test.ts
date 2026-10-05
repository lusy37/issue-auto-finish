import { describe, expect, it } from 'vitest';
import { getAllowedActions, isReviewWaiting, needsIntervention } from '../../src/web/frontend/src/adapters/issueflowViewModel.js';
import { newIssueRun } from '../../src/dag/contracts.js';
import type { IssueRecord } from '../../src/web/frontend/src/types/index.js';

const record = (lifecycle: IssueRecord['lifecycle'], preview?: IssueRecord['preview']): IssueRecord => ({
  lifecycle,
  run: newIssueRun(),
  phaseHistory: [],
  branchName: 'iaf/42',
  demandSpec: { demandId: '42', sourceRef: { source: 'github-issue', externalId: '42' }, title: '需求', description: '描述', createdAt: '' },
  createdAt: '2026-09-21T00:00:00.000Z',
  updatedAt: '2026-09-21T00:01:00.000Z',
  preview,
});

describe('issueflow view model', () => {
  it('失败和暂停均进入人工介入待办，审核继续使用独立入口', () => {
    expect(needsIntervention({ kind: 'failed', phase: 'uat', retry: 'manual', error: { message: '次数耗尽', retryable: 'hard-no-auto' } })).toBe(true);
    expect(needsIntervention({ kind: 'paused', phase: 'build' })).toBe(true);
    expect(needsIntervention({ kind: 'waiting', phase: 'review' })).toBe(false);
    expect(needsIntervention({ kind: 'completed' })).toBe(false);
  });
  it('根据 Native 生命周期计算可用操作', () => {
    expect(getAllowedActions(record({ kind: 'waiting', phase: 'review', planRevision: 2 }))).toEqual(['abort', 'restart', 'restart-preview', 'cancel']);
    expect(getAllowedActions(record({ kind: 'paused', phase: 'build' }))).toEqual(['continue', 'redo-phase', 'restart', 'restart-preview', 'cancel']);
    expect(getAllowedActions(record({ kind: 'failed', retry: 'manual', error: { message: '失败', retryable: 'hard' } }, { running: true }))).toEqual(['retry', 'restart', 'stop-preview', 'cancel']);
    expect(getAllowedActions(record({ kind: 'completed' }))).toEqual(['restart', 'restart-preview']);
  });

  it('仅把审核阶段的 waiting 任务计入待审核', () => {
    expect(isReviewWaiting({ kind: 'waiting', phase: 'review', planRevision: 2 })).toBe(true);
    expect(isReviewWaiting({ kind: 'paused', phase: 'plan' })).toBe(false);
    expect(isReviewWaiting({ kind: 'waiting', phase: 'plan' })).toBe(false);
  });
});
