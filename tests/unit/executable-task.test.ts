import { describe, expect, it } from 'vitest';
import {
  issueStateCategory,
  issueStateToUnified,
  issueToExecutableTask,
  type UnifiedTaskStatus,
} from '../../src/tracker/ExecutableTask.js';
import type { IssueRecord } from '../../src/tracker/IssueRecord.js';
import type { IssueLifecycle } from '../../src/tracker/IssueLifecycle.js';
import { PLAN_MODE_PIPELINE } from '../../src/pipeline/PipelineMetadata.js';
import { newIssueRun } from '../../src/dag/contracts.js';

function makeIssueRecord(lifecycle: IssueLifecycle = { kind: 'pending' }): IssueRecord {
  const now = new Date().toISOString();
  return {
    lifecycle,
    branchName: 'feat/issue-1',
    createdAt: now,
    updatedAt: now,
    run: newIssueRun(),
    phaseHistory: [],
    demandSpec: {
      demandId: 'gh-1',
      sourceRef: { source: 'github-issue', externalId: '100', displayId: '1' },
      title: 'Test Issue',
      description: '',
      createdAt: now,
    },
  };
}

describe('issueStateToUnified', () => {
  it.each([
    ['idle', 'idle'], ['skipped', 'idle'], ['ready', 'preparing'],
    ['running', 'running'], ['waiting', 'waiting'], ['done', 'completed'],
    ['failed', 'failed'], ['unknown', 'idle'],
  ] as const)('%s → %s', (input, expected) => {
    expect(issueStateToUnified(input)).toBe(expected);
  });

  it('所有统一状态均可由页面动作投影得到', () => {
    const statuses = ['idle', 'skipped', 'ready', 'running', 'waiting', 'done', 'failed'];
    const actual = new Set(statuses.map(issueStateToUnified));
    const expected: UnifiedTaskStatus[] = ['idle', 'preparing', 'running', 'waiting', 'completed', 'failed'];
    for (const status of expected) expect(actual.has(status)).toBe(true);
  });
});

describe('issueToExecutableTask', () => {
  it.each([
    [{ kind: 'pending' }, 'idle', 'active'],
    [{ kind: 'running', phase: 'plan' }, 'running', 'active'],
    [{ kind: 'completed' }, 'completed', 'completed'],
    [{ kind: 'skipped' }, 'idle', 'skipped'],
  ] as const)('直接投影生命周期 %#', (lifecycle, status, category) => {
    const task = issueToExecutableTask(makeIssueRecord(lifecycle), PLAN_MODE_PIPELINE);
    expect(task.lifecycle).toEqual(lifecycle);
    expect(task.status).toBe(status);
    expect(task.stateCategory).toBe(category);
    expect(task).not.toHaveProperty('sourceState');
  });

  it('失败信息和重试次数来自 lifecycle 与运行预算', () => {
    const record = makeIssueRecord({
      kind: 'failed', phase: 'plan', retry: 'auto',
      error: { message: 'some error', retryable: 'hard' },
    });
    record.run.retryUsed = { plan: 2 };
    const task = issueToExecutableTask(record, PLAN_MODE_PIPELINE);
    expect(task.status).toBe('failed');
    expect(task.attempts).toBe(2);
    expect(task.lastError).toBe('some error');
    expect(task.stateCategory).toBe('failed');
  });
});

describe('issueStateCategory', () => {
  it.each([
    [{ kind: 'running', phase: 'plan' }, 'active'],
    [{ kind: 'completed' }, 'completed'],
    [{ kind: 'failed', retry: 'manual', error: { message: 'error', retryable: 'hard-no-auto' } }, 'failed'],
    [{ kind: 'skipped' }, 'skipped'],
    [{ kind: 'paused', phase: 'build' }, 'blocked'],
  ] as const)('按生命周期分类 %#', (lifecycle, category) => {
    expect(issueStateCategory(makeIssueRecord(lifecycle))).toBe(category);
  });
});
