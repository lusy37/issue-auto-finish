import { describe, expect, it } from 'vitest';
import { ActionLifecycleManager } from '../../src/lifecycle/ActionLifecycleManager.js';
import { PLAN_MODE_PIPELINE } from '../../src/pipeline/PipelineMetadata.js';
import { IssueState, deriveOrchestrationState, type IssueRecord } from '../../src/tracker/IssueState.js';
import { newIssueRun } from '../../src/dag/contracts.js';

const record = (state: IssueState, currentPhase?: string): IssueRecord => ({
  state,
  currentPhase,
  orchestrationState: deriveOrchestrationState({ state, currentPhase }),
  branchName: 'iaf-1',
  attempts: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  run: newIssueRun(),
});

describe('Native 状态职责特征', () => {
  const lifecycle = new ActionLifecycleManager(PLAN_MODE_PIPELINE);

  it.each([
    IssueState.BranchCreated,
    IssueState.PhaseDone,
    IssueState.PhaseApproved,
  ])('%s 都只表达可以再次驱动，具体节点不由父状态决定', state => {
    expect(lifecycle.isDrivable(state, 0, 2)).toBe(true);
  });

  it('审核等待同时保留阶段和计划版本事实', () => {
    const value = record(IssueState.PhaseWaiting, 'review');
    value.run!.planRevision = 3;
    value.run!.review = { revision: 3, decision: 'waiting' };
    value.orchestrationState = {
      kind: 'gate-waiting',
      phaseId: 'review',
      reason: 'human-review',
      payload: { planRevision: 3 },
    };

    expect(value.currentPhase).toBe('review');
    expect(value.run!.review).toEqual({ revision: 3, decision: 'waiting' });
  });

  it('阶段列表、任务、调用、合并和交付分别保存独立业务事实', () => {
    const value = record(IssueState.PhaseRunning, 'build');
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
