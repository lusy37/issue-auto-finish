import { describe, expect, it } from 'vitest';
import type { IssueRecord } from '../../src/tracker/IssueRecord.js';
import { newIssueRun } from '../../src/dag/contracts.js';
import { isLifecycleSchedulable, type IssueLifecycle } from '../../src/tracker/IssueLifecycle.js';

const record = (lifecycle: IssueLifecycle): IssueRecord => ({
  lifecycle,
  branchName: 'iaf-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  demandSpec: { demandId: 'gh-1', sourceRef: { source: 'github-issue', externalId: '1', displayId: '1' }, title: '需求', description: '', createdAt: '2026-01-01T00:00:00.000Z' },
  run: newIssueRun(),
  phaseHistory: [],
});

describe('Native 状态职责特征', () => {
  it('ready 只表达可以再次驱动，具体节点不由父状态决定', () => {
    expect(isLifecycleSchedulable({ kind: 'ready' })).toBe(true);
  });

  it('审核等待同时保留阶段和计划版本事实', () => {
    const value = record({ kind: 'waiting', phase: 'review', planRevision: 3 });
    value.run!.planRevision = 3;
    value.run!.review = { revision: 3, decision: 'waiting' };
    expect(value.lifecycle).toEqual({ kind: 'waiting', phase: 'review', planRevision: 3 });
    expect(value.run!.review).toEqual({ revision: 3, decision: 'waiting' });
  });

  it('阶段列表、任务、调用、合并和交付分别保存独立业务事实', () => {
    const value = record({ kind: 'running', phase: 'build' });
    value.phaseProgress = {
      plan: { status: 'completed' },
      review: { status: 'completed' },
      build: { status: 'in_progress' },
      verify: { status: 'pending' },
      uat: { status: 'pending' },
    };
    value.run!.tasks.task = {
      taskId: 'task',
      status: 'merging',
      attemptNo: 1,
      conflictCallsUsed: 0,
      merge: {
        operationId: 'merge-1',
        stage: 'rebasing',
        preRebaseCommit: 'a',
        integrationBefore: 'b',
      },
    };
    value.run!.calls.call = {
      identity: {
        issueNumber: 1,
        planRevision: 1,
        buildGeneration: 0,
        dispatchId: 'dispatch',
        taskId: 'task',
        attemptNo: 1,
        callId: 'call',
      },
      workDir: 'work',
      status: 'running',
    };
    value.run!.delivery = {
      repository: 'owner/repo',
      issueNumber: 1,
      sourceBranch: 'iaf-1',
      targetBranch: 'main',
      marker: 'marker',
      creation: 'unknown',
    };

    expect(Object.hasOwn(value.phaseProgress, 'uat')).toBe(true);
    expect(value.run!.tasks.task.status).toBe('merging');
    expect(value.run!.calls.call.status).toBe('running');
    expect(value.run!.tasks.task.merge?.stage).toBe('rebasing');
    expect(value.run!.delivery.creation).toBe('unknown');
  });
});
