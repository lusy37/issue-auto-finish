import { describe, it, expect } from 'vitest';
import {
  issueStateToUnified,
  issueToExecutableTask,
  issueStateCategory,
  type UnifiedTaskStatus,
} from '../../src/tracker/ExecutableTask.js';
import { IssueState, type IssueRecord } from '../../src/tracker/IssueState.js';
import { PLAN_MODE_PIPELINE } from '../../src/pipeline/PipelineMetadata.js';
import { newIssueRun } from '../../src/dag/contracts.js';

const planModeDef = PLAN_MODE_PIPELINE;

function makeIssueRecord(overrides?: Partial<IssueRecord>): IssueRecord {
  const now = new Date().toISOString();
  return {
    lifecycle: { kind: 'pending' },
    state: IssueState.Pending,
    orchestrationState: { kind: 'queued' },
    branchName: 'feat/issue-1',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    run: newIssueRun(),
    demandSpec: {
      demandId: 'gh-1',
      sourceRef: { source: 'github-issue', externalId: '100', displayId: '1' },
      title: 'Test Issue',
      description: '',
      createdAt: now,
    },
    ...overrides,
  };
}

describe('issueStateToUnified', () => {
  it('maps idle → idle', () => {
    expect(issueStateToUnified('idle')).toBe('idle');
  });

  it('maps skipped → idle', () => {
    expect(issueStateToUnified('skipped')).toBe('idle');
  });

  it('maps ready → preparing', () => {
    expect(issueStateToUnified('ready')).toBe('preparing');
  });

  it('maps running → running', () => {
    expect(issueStateToUnified('running')).toBe('running');
  });

  it('maps waiting → waiting', () => {
    expect(issueStateToUnified('waiting')).toBe('waiting');
  });

  it('maps done → completed', () => {
    expect(issueStateToUnified('done')).toBe('completed');
  });

  it('maps failed → failed', () => {
    expect(issueStateToUnified('failed')).toBe('failed');
  });

  it('maps unknown → idle', () => {
    expect(issueStateToUnified('something_else')).toBe('idle');
  });
});

describe('issueToExecutableTask', () => {
  it('projects a pending IssueRecord correctly', () => {
    const record = makeIssueRecord();
    const task = issueToExecutableTask(record, planModeDef);

    expect(task.kind).toBe('issue');
    expect(task.taskId).toBe('1');
    expect(task.title).toBe('Test Issue');
    expect(task.status).toBe('idle');
    expect(task.attempts).toBe(0);
    expect(task.createdAt).toBe(record.createdAt);
    expect(task.updatedAt).toBe(record.updatedAt);
    expect(task.branchName).toBe('feat/issue-1');
    expect(task.sourceState).toBe(IssueState.Pending);
    expect(task.stateCategory).toBe('active');
  });

  it('projects a running IssueRecord correctly', () => {
    const record = makeIssueRecord({ lifecycle: { kind: 'running', phase: 'plan' }, state: IssueState.PhaseRunning, currentPhase: 'plan' });
    const task = issueToExecutableTask(record, planModeDef);
    expect(task.status).toBe('running');
    expect(task.sourceState).toBe(IssueState.PhaseRunning);
    expect(task.stateCategory).toBe('active');
  });

  it('projects a completed IssueRecord correctly', () => {
    const record = makeIssueRecord({ lifecycle: { kind: 'completed' }, state: IssueState.Completed });
    const task = issueToExecutableTask(record, planModeDef);
    expect(task.status).toBe('completed');
    expect(task.sourceState).toBe(IssueState.Completed);
    expect(task.stateCategory).toBe('completed');
  });

  it('projects a failed IssueRecord correctly', () => {
    const record = makeIssueRecord({
      state: IssueState.Failed,
      lifecycle: { kind: 'failed', phase: 'plan', retry: 'auto', error: { message: 'some error', retryable: 'hard' } },
      attempts: 2,
      lastError: 'some error',
    });
    const task = issueToExecutableTask(record, planModeDef);
    expect(task.status).toBe('failed');
    expect(task.attempts).toBe(2);
    expect(task.lastError).toBe('some error');
    expect(task.sourceState).toBe(IssueState.Failed);
    expect(task.stateCategory).toBe('failed');
  });

  it('projects a skipped IssueRecord correctly', () => {
    const record = makeIssueRecord({ lifecycle: { kind: 'skipped' }, state: IssueState.Skipped });
    const task = issueToExecutableTask(record, planModeDef);
    expect(task.stateCategory).toBe('skipped');
  });
});

describe('UnifiedTaskStatus completeness', () => {
  it('all UnifiedTaskStatus values are reachable from issueStateToUnified', () => {
    const actionStatuses = ['idle', 'skipped', 'ready', 'running', 'waiting', 'done', 'failed'];
    const results = new Set(actionStatuses.map(issueStateToUnified));
    const expected: UnifiedTaskStatus[] = ['idle', 'preparing', 'running', 'waiting', 'completed', 'failed'];
    for (const s of expected) {
      expect(results.has(s), `${s} should be reachable`).toBe(true);
    }
  });
});

describe('issueStateCategory', () => {
  it('returns active for running states', () => {
    const record = makeIssueRecord({ lifecycle: { kind: 'running', phase: 'plan' }, state: IssueState.PhaseRunning, currentPhase: 'plan' });
    expect(issueStateCategory(record)).toBe('active');
  });

  it('returns completed for completed state', () => {
    const record = makeIssueRecord({ lifecycle: { kind: 'completed' }, state: IssueState.Completed });
    expect(issueStateCategory(record)).toBe('completed');
  });

  it('returns failed for failed state', () => {
    const record = makeIssueRecord({ lifecycle: { kind: 'failed', retry: 'manual', error: { message: 'error', retryable: 'hard-no-auto' } }, state: IssueState.Failed });
    expect(issueStateCategory(record)).toBe('failed');
  });

  it('returns skipped for skipped state', () => {
    const record = makeIssueRecord({ lifecycle: { kind: 'skipped' }, state: IssueState.Skipped });
    expect(issueStateCategory(record)).toBe('skipped');
  });
});
