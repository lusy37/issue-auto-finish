import { describe, expect, it } from 'vitest';
import { getAllowedActions, toWorkbenchRow } from '../../src/web/frontend/src/adapters/issueflowViewModel.js';
import type { ExecutableTask, IssueRecord } from '../../src/web/frontend/src/types/index.js';

const task = (overrides: Partial<ExecutableTask> = {}): ExecutableTask => ({
  kind: 'issue',
  taskId: '42',
  title: '重构工作台',
  status: 'running',
  attempts: 1,
  createdAt: '2026-09-21T00:00:00.000Z',
  updatedAt: '2026-09-21T00:01:00.000Z',
  lifecycle: { kind: 'running', phase: 'build' },
  phaseProgress: [
    { name: 'plan', label: '计划', status: 'completed' },
    { name: 'build', label: '构建', status: 'in_progress' },
    { name: 'verify', label: '验证', status: 'pending' },
  ],
  ...overrides,
});

const record = (lifecycle: IssueRecord['lifecycle'], preview?: IssueRecord['preview']): IssueRecord => ({
  lifecycle,
  branchName: 'iaf/42',
  demandSpec: { demandId: '42', sourceRef: { source: 'github-issue', externalId: '42' }, title: '需求', description: '描述' },
  createdAt: '2026-09-21T00:00:00.000Z',
  updatedAt: '2026-09-21T00:01:00.000Z',
  preview,
});

describe('issueflow view model', () => {
  it('保留真实任务字段并计算工作台展示摘要', () => {
    const row = toWorkbenchRow(task());
    expect(row.issueNumber).toBe(42);
    expect(row.statusLabel).toContain('构建');
    expect(row.progressPercent).toBe(50);
    expect(row.activePhaseLabel).toBe('构建');
  });

  it('根据 Native 生命周期计算可用操作', () => {
    expect(getAllowedActions(record({ kind: 'waiting', phase: 'review', planRevision: 2 }))).toEqual(['abort', 'restart', 'restart-preview', 'cancel']);
    expect(getAllowedActions(record({ kind: 'paused', phase: 'build' }))).toEqual(['continue', 'redo-phase', 'restart', 'restart-preview', 'cancel']);
    expect(getAllowedActions(record({ kind: 'failed', retry: 'manual', error: { message: '失败', retryable: 'hard' } }, { running: true }))).toEqual(['retry', 'restart', 'stop-preview', 'cancel']);
    expect(getAllowedActions(record({ kind: 'completed' }))).toEqual(['restart', 'restart-preview']);
  });
});
