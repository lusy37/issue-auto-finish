import { describe, it, expect } from 'vitest';
import {
  issueStateToUnified,
  taskStatusToUnified,
  issueToExecutableTask,
  braindumpTaskToExecutableTask,
  unifiedStatusToCategory,
  issueStateCategory,
  type UnifiedTaskStatus,
} from '../../src/tracker/ExecutableTask.js';
import { IssueState, type IssueRecord } from '../../src/tracker/IssueState.js';
import { PLAN_MODE_PIPELINE, createLifecycleManager } from '../../src/pipeline/PipelineDefinition.js';

const planModeLM = createLifecycleManager(PLAN_MODE_PIPELINE);

function makeIssueRecord(overrides?: Partial<IssueRecord>): IssueRecord {
  const now = new Date().toISOString();
  return {
    state: IssueState.Pending,
    branchName: 'feat/issue-1',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
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

function makeBraindumpTask(overrides?: Partial<BraindumpTask>): BraindumpTask {
  return {
    id: 'task-1',
    index: 0,
    title: 'Task 1',
    description: 'Do something',
    dependsOn: [],
    branchName: 'braindump/batch-1/task-1',
    status: TaskStatus.Pending,
    attempts: 0,
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
    const task = issueToExecutableTask(record, planModeLM);

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
    const record = makeIssueRecord({ state: IssueState.PhaseRunning, currentPhase: 'plan' });
    const task = issueToExecutableTask(record, planModeLM);
    expect(task.status).toBe('running');
    expect(task.sourceState).toBe(IssueState.PhaseRunning);
    expect(task.stateCategory).toBe('active');
  });

  it('projects a completed IssueRecord correctly', () => {
    const record = makeIssueRecord({ state: IssueState.Completed });
    const task = issueToExecutableTask(record, planModeLM);
    expect(task.status).toBe('completed');
    expect(task.sourceState).toBe(IssueState.Completed);
    expect(task.stateCategory).toBe('completed');
  });

  it('projects a failed IssueRecord correctly', () => {
    const record = makeIssueRecord({
      state: IssueState.Failed,
      attempts: 2,
      lastError: 'some error',
    });
    const task = issueToExecutableTask(record, planModeLM);
    expect(task.status).toBe('failed');
    expect(task.attempts).toBe(2);
    expect(task.lastError).toBe('some error');
    expect(task.sourceState).toBe(IssueState.Failed);
    expect(task.stateCategory).toBe('failed');
  });

  it('projects a skipped IssueRecord correctly', () => {
    const record = makeIssueRecord({ state: IssueState.Skipped });
    const task = issueToExecutableTask(record, planModeLM);
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

describe('unifiedStatusToCategory', () => {
  it('maps running → active', () => {
    expect(unifiedStatusToCategory('running')).toBe('active');
  });

  it('maps preparing → active', () => {
    expect(unifiedStatusToCategory('preparing')).toBe('active');
  });

  it('maps merging → active', () => {
    expect(unifiedStatusToCategory('merging')).toBe('active');
  });

  it('maps waiting → blocked', () => {
    expect(unifiedStatusToCategory('waiting')).toBe('blocked');
  });

  it('maps completed → completed', () => {
    expect(unifiedStatusToCategory('completed')).toBe('completed');
  });

  it('maps failed → failed', () => {
    expect(unifiedStatusToCategory('failed')).toBe('failed');
  });

  it('maps idle → idle', () => {
    expect(unifiedStatusToCategory('idle')).toBe('idle');
  });
});

describe('issueStateCategory', () => {
  it('returns active for running states', () => {
    const record = makeIssueRecord({ state: IssueState.PhaseRunning, currentPhase: 'plan' });
    expect(issueStateCategory(record, planModeLM)).toBe('active');
  });

  it('returns completed for completed state', () => {
    const record = makeIssueRecord({ state: IssueState.Completed });
    expect(issueStateCategory(record, planModeLM)).toBe('completed');
  });

  it('returns failed for failed state', () => {
    const record = makeIssueRecord({ state: IssueState.Failed });
    expect(issueStateCategory(record, planModeLM)).toBe('failed');
  });

  it('returns skipped for skipped state', () => {
    const record = makeIssueRecord({ state: IssueState.Skipped });
    expect(issueStateCategory(record, planModeLM)).toBe('skipped');
  });
});
