import { structuredPlanOutput } from '../helpers/structured-plan.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlanPhase } from '../../src/phases/PlanPhase.js';
import { BuildPhase } from '../../src/phases/BuildPhase.js';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import type { PhaseContext } from '../../src/phases/BasePhase.js';
import type { DemandSpec } from '../../src/demand/DemandSpec.js';
import type { RunResult } from '../../src/ai-runner/index.js';
import { IssueTracker } from '../../src/tracker/IssueTracker.js';
import { IssueState, type PhaseProgress } from '../../src/tracker/IssueState.js';
import { PLAN_MODE_PIPELINE } from '../../src/pipeline/PipelineMetadata.js';
import {
  createMockAIRunner,
  createMockGitOperations,
  createTestConfig,
} from '../helpers/mock-factories.js';

function createTestDemand(overrides?: Partial<DemandSpec>): DemandSpec {
  return {
    demandId: 'gh-42',
    sourceRef: { source: 'github-issue', externalId: '100', displayId: '42' },
    title: 'Test Issue',
    description: 'Test description',
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function createTracker(dataDir: string): IssueTracker {
  const tracker = new IssueTracker(dataDir, new Map([['plan-mode', PLAN_MODE_PIPELINE]]));
  tracker.create({
    state: IssueState.Pending,
    pipelineMode: 'plan-mode',
    demandSpec: createTestDemand(),
    branchName: 'feat/issue-42',
  });
  tracker.initPhaseProgress(42, PLAN_MODE_PIPELINE);
  return tracker;
}

function setPhaseProgress(
  tracker: IssueTracker,
  phase: string,
  progress: PhaseProgress,
): void {
  tracker.transaction(42, record => {
    record.phaseProgress ??= {};
    record.phaseProgress[phase] = progress;
  });
}

describe('Session Resume — 聚合状态', () => {
  let tmpDir: string;
  let tracker: IssueTracker;
  let plan: PlanPersistence;
  let aiRunner: ReturnType<typeof createMockAIRunner>;

  const ctx: PhaseContext = {
    demand: createTestDemand(),
    branchName: 'feat/issue-42',
    pipelineMode: 'plan-mode',
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-resume-'));
    const dataDir = path.join(tmpDir, 'data');
    tracker = createTracker(dataDir);
    plan = new PlanPersistence(tmpDir, 42, dataDir, tracker);
    plan.ensureDir();
    aiRunner = createMockAIRunner();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('待执行阶段不会使用遗留 session', async () => {
    setPhaseProgress(tracker, 'plan', { status: 'pending', sessionId: 'stale-session' });
    const phase = new PlanPhase(aiRunner, createMockGitOperations() as never, plan, createTestConfig(), tracker);

    await phase.run(ctx);

    expect(aiRunner.run.mock.calls[0][0].sessionId).toBeUndefined();
    expect(aiRunner.run.mock.calls[0][0].continueSession).toBeUndefined();
  });

  it.each(['failed', 'in_progress'] as const)('%s 阶段从聚合状态恢复 session', async status => {
    setPhaseProgress(tracker, 'plan', { status, sessionId: 'previous-session' });
    const phase = new PlanPhase(aiRunner, createMockGitOperations() as never, plan, createTestConfig(), tracker);

    await phase.run(ctx);

    expect(aiRunner.run.mock.calls[0][0].sessionId).toBe('previous-session');
    expect(aiRunner.run.mock.calls[0][0].continueSession).toBe(true);
  });

  it('恢复会话失效时回退到新会话', async () => {
    setPhaseProgress(tracker, 'plan', { status: 'failed', sessionId: 'expired-session' });
    const resumeFailure: RunResult = {
      success: false,
      output: '',
      errorMessage: 'Session not found',
      exitCode: 1,
    };
    aiRunner.run
      .mockResolvedValueOnce(resumeFailure)
      .mockResolvedValueOnce({
        success: true,
        output: structuredPlanOutput('完整实施计划：包含步骤、边界与验收标准。'.repeat(8)),
        sessionId: 'fresh-session',
        exitCode: 0,
      });
    const phase = new PlanPhase(aiRunner, createMockGitOperations() as never, plan, createTestConfig(), tracker);

    const result = await phase.run(ctx);

    expect(result.kind).toBe('completed');
    expect(aiRunner.run).toHaveBeenCalledTimes(2);
    expect(aiRunner.run.mock.calls[0][0]).toMatchObject({ sessionId: 'expired-session', continueSession: true });
    expect(aiRunner.run.mock.calls[1][0].sessionId).toBeUndefined();
  });

  it('执行结果与流事件捕获的 session 均写回聚合状态', async () => {
    setPhaseProgress(tracker, 'plan', { status: 'in_progress' });
    aiRunner.run.mockImplementation(async options => {
      options.onStreamEvent?.({
        type: 'init',
        content: { type: 'init', session_id: 'stream-session' },
        timestamp: new Date().toISOString(),
      });
      return {
        success: true,
        output: structuredPlanOutput('完整实施计划：包含步骤、边界与验收标准。'.repeat(8)),
        sessionId: 'result-session',
        exitCode: 0,
      };
    });
    const phase = new PlanPhase(aiRunner, createMockGitOperations() as never, plan, createTestConfig(), tracker);

    await phase.run(ctx);

    expect(tracker.getPhaseProgress(42, 'plan')?.sessionId).toBe('result-session');
  });

  it('BuildPhase 使用相同的聚合状态恢复规则', async () => {
    setPhaseProgress(tracker, 'build', { status: 'failed', sessionId: 'build-session' });
    const git = createMockGitOperations();
    git.hasChanges.mockResolvedValue(true);
    const phase = new BuildPhase(aiRunner, git as never, plan, createTestConfig(), tracker);

    await phase.run(ctx);

    expect(aiRunner.run.mock.calls[0][0]).toMatchObject({
      sessionId: 'build-session',
      continueSession: true,
    });
  });
});
