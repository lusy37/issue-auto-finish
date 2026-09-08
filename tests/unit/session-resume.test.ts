import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlanPhase } from '../../src/phases/PlanPhase.js';
import { BuildPhase } from '../../src/phases/BuildPhase.js';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import type { PhaseContext } from '../../src/phases/BasePhase.js';
import type { DemandSpec } from '../../src/demand/DemandSpec.js';
import type { RunResult } from '../../src/ai-runner/index.js';
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

function writePlanFile(tmpDir: string, content = '# Plan\n\nDetailed implementation plan with enough content to pass validation.\n') {
  const planDir = path.join(tmpDir, '.claude-plan', 'issue-42');
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, '01-plan.md'), content);
}

describe('Session Resume — PlanPersistence', () => {
  let tmpDir: string;
  let plan: PlanPersistence;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-resume-test-'));
    plan = new PlanPersistence(tmpDir, 42);
    plan.ensureDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getPhaseSessionId returns undefined when no progress exists', () => {
    expect(plan.getPhaseSessionId('plan')).toBeUndefined();
  });

  it('getPhaseSessionId returns undefined when phase has no sessionId', () => {
    plan.writeProgress({
      displayId: 42,
      title: 'Test',
      branchName: 'feat/42',
      currentPhase: 'plan',
      phases: { plan: { status: 'pending' } },
    });
    expect(plan.getPhaseSessionId('plan')).toBeUndefined();
  });

  it('updatePhaseSessionId persists and getPhaseSessionId retrieves it', () => {
    plan.writeProgress({
      displayId: 42,
      title: 'Test',
      branchName: 'feat/42',
      currentPhase: 'plan',
      phases: { plan: { status: 'in_progress' } },
    });
    plan.updatePhaseSessionId('plan', 'sess-abc-123');
    expect(plan.getPhaseSessionId('plan')).toBe('sess-abc-123');
  });

  it('updatePhaseProgress clears sessionId on in_progress by default', () => {
    plan.writeProgress({
      displayId: 42,
      title: 'Test',
      branchName: 'feat/42',
      currentPhase: 'plan',
      phases: { plan: { status: 'failed', sessionId: 'old-session' } },
    });

    plan.updatePhaseProgress('plan', 'in_progress');
    expect(plan.getPhaseSessionId('plan')).toBeUndefined();
  });

  it('updatePhaseProgress preserves sessionId when preserveSessionId=true', () => {
    plan.writeProgress({
      displayId: 42,
      title: 'Test',
      branchName: 'feat/42',
      currentPhase: 'plan',
      phases: { plan: { status: 'failed', sessionId: 'old-session' } },
    });

    plan.updatePhaseProgress('plan', 'in_progress', undefined, { preserveSessionId: true });
    expect(plan.getPhaseSessionId('plan')).toBe('old-session');
  });

  it('updatePhaseProgress does not clear sessionId on failed status', () => {
    plan.writeProgress({
      displayId: 42,
      title: 'Test',
      branchName: 'feat/42',
      currentPhase: 'plan',
      phases: { plan: { status: 'in_progress', sessionId: 'current-session' } },
    });

    plan.updatePhaseProgress('plan', 'failed', 'some error');
    expect(plan.getPhaseSessionId('plan')).toBe('current-session');
  });
});

describe('Session Resume — BasePhase.run()', () => {
  let tmpDir: string;
  let plan: PlanPersistence;
  let aiRunner: ReturnType<typeof createMockAIRunner>;

  const ctx: PhaseContext = {
    demand: createTestDemand(),
    branchName: 'feat/issue-42',
    pipelineMode: 'plan-mode',
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-resume-phase-'));
    plan = new PlanPersistence(tmpDir, 42);
    plan.ensureDir();
    aiRunner = createMockAIRunner();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fresh execution: does not pass sessionId/continueSession', async () => {
    writePlanFile(tmpDir);
    const phase = new PlanPhase(
      aiRunner, createMockGitOperations() as any, plan,
      createTestConfig(),
    );

    await phase.run(ctx);

    const runCall = aiRunner.run.mock.calls[0][0];
    expect(runCall.sessionId).toBeUndefined();
    expect(runCall.continueSession).toBeUndefined();
  });

  it('fresh execution: saves sessionId from RunResult', async () => {
    plan.writeProgress({
      displayId: 42, title: 'Test', branchName: 'feat/42',
      currentPhase: 'plan',
      phases: { plan: { status: 'pending' } },
    });
    writePlanFile(tmpDir);
    aiRunner.run.mockResolvedValue({
      success: true,
      output: '计划实施步骤及验收标准。'.repeat(10),
      sessionId: 'new-session-xyz',
      exitCode: 0,
    });

    const phase = new PlanPhase(
      aiRunner, createMockGitOperations() as any, plan,
      createTestConfig(),
    );

    await phase.run(ctx);

    expect(plan.getPhaseSessionId('plan')).toBe('new-session-xyz');
  });

  it('resume: passes sessionId and continueSession when previous session exists and phase was failed', async () => {
    plan.writeProgress({
      displayId: 42,
      title: 'Test',
      branchName: 'feat/42',
      currentPhase: 'plan',
      phases: { plan: { status: 'failed', sessionId: 'prev-session-123' } },
    });
    writePlanFile(tmpDir);

    const phase = new PlanPhase(
      aiRunner, createMockGitOperations() as any, plan,
      createTestConfig(),
    );

    await phase.run(ctx);

    const runCall = aiRunner.run.mock.calls[0][0];
    expect(runCall.sessionId).toBe('prev-session-123');
    expect(runCall.continueSession).toBe(true);
    expect(runCall.prompt).toContain('中断');
  });

  it('resume: passes sessionId and continueSession when phase was in_progress (interrupted)', async () => {
    plan.writeProgress({
      displayId: 42,
      title: 'Test',
      branchName: 'feat/42',
      currentPhase: 'plan',
      phases: { plan: { status: 'in_progress', sessionId: 'interrupted-session' } },
    });
    writePlanFile(tmpDir);

    const phase = new PlanPhase(
      aiRunner, createMockGitOperations() as any, plan,
      createTestConfig(),
    );

    await phase.run(ctx);

    const runCall = aiRunner.run.mock.calls[0][0];
    expect(runCall.sessionId).toBe('interrupted-session');
    expect(runCall.continueSession).toBe(true);
  });

  it('no resume when phase status is pending (fresh start)', async () => {
    plan.writeProgress({
      displayId: 42,
      title: 'Test',
      branchName: 'feat/42',
      currentPhase: 'plan',
      phases: { plan: { status: 'pending', sessionId: 'stale-session' } },
    });
    writePlanFile(tmpDir);

    const phase = new PlanPhase(
      aiRunner, createMockGitOperations() as any, plan,
      createTestConfig(),
    );

    await phase.run(ctx);

    const runCall = aiRunner.run.mock.calls[0][0];
    expect(runCall.sessionId).toBeUndefined();
    expect(runCall.continueSession).toBeUndefined();
  });

  it('resume fallback: retries with fresh session when resume fails with session error', async () => {
    plan.writeProgress({
      displayId: 42,
      title: 'Test',
      branchName: 'feat/42',
      currentPhase: 'plan',
      phases: { plan: { status: 'failed', sessionId: 'expired-session' } },
    });
    writePlanFile(tmpDir);

    const resumeFailResult: RunResult = {
      success: false,
      output: '',
      errorMessage: 'Session not found',
      exitCode: 1,
    };
    const freshResult: RunResult = {
      success: true,
      output: '完整实施计划：包含步骤、边界与验收标准。'.repeat(8),
      sessionId: 'fresh-session',
      exitCode: 0,
    };

    aiRunner.run
      .mockResolvedValueOnce(resumeFailResult)
      .mockResolvedValueOnce(freshResult);

    const phase = new PlanPhase(
      aiRunner, createMockGitOperations() as any, plan,
      createTestConfig(),
    );

    const intent = await phase.run(ctx);
    expect(intent.kind).toBe('completed');
    expect(aiRunner.run).toHaveBeenCalledTimes(2);

    // First call should be a resume attempt
    const firstCall = aiRunner.run.mock.calls[0][0];
    expect(firstCall.sessionId).toBe('expired-session');
    expect(firstCall.continueSession).toBe(true);

    // Second call should be fresh (no sessionId/continueSession)
    const secondCall = aiRunner.run.mock.calls[1][0];
    expect(secondCall.sessionId).toBeUndefined();
    expect(secondCall.continueSession).toBeUndefined();
  });

  it('resume failure: does NOT fallback when failure is not resume-related', async () => {
    plan.writeProgress({
      displayId: 42,
      title: 'Test',
      branchName: 'feat/42',
      currentPhase: 'plan',
      phases: { plan: { status: 'failed', sessionId: 'valid-session' } },
    });

    const nonResumeFailResult: RunResult = {
      success: false,
      output: 'Some substantial AI output that indicates real work happened',
      errorMessage: 'AI execution timed out after 1800000ms',
      exitCode: null,
      timeoutType: 'wall-clock',
    };

    aiRunner.run.mockResolvedValueOnce(nonResumeFailResult);

    const phase = new PlanPhase(
      aiRunner, createMockGitOperations() as any, plan,
      createTestConfig(),
    );

    const intent = await phase.run(ctx);
    expect(intent.kind).toBe('failed');
    // Should NOT retry — only one call
    expect(aiRunner.run).toHaveBeenCalledTimes(1);
  });

  it('failed execution: persists sessionId even on failure', async () => {
    plan.writeProgress({
      displayId: 42, title: 'Test', branchName: 'feat/42',
      currentPhase: 'plan',
      phases: { plan: { status: 'pending' } },
    });

    const failResult: RunResult = {
      success: false,
      output: 'Some substantial output',
      errorMessage: 'AI execution timed out',
      sessionId: 'fail-session-id',
      exitCode: null,
      timeoutType: 'wall-clock',
    };

    aiRunner.run.mockResolvedValueOnce(failResult);

    const phase = new PlanPhase(
      aiRunner, createMockGitOperations() as any, plan,
      createTestConfig(),
    );

    const failIntent = await phase.run(ctx);
    expect(failIntent.kind).toBe('failed');
    expect(plan.getPhaseSessionId('plan')).toBe('fail-session-id');
  });

  it('stream event: captures sessionId from stream events', async () => {
    plan.writeProgress({
      displayId: 42, title: 'Test', branchName: 'feat/42',
      currentPhase: 'plan',
      phases: { plan: { status: 'pending' } },
    });

    aiRunner.run.mockImplementation(async (options) => {
      // Simulate a stream event with session_id
      options.onStreamEvent?.({
        type: 'init',
        content: { type: 'init', session_id: 'stream-captured-session' },
        timestamp: new Date().toISOString(),
      });
      return { success: true, output: '完整实施计划：包含步骤、边界与验收标准。'.repeat(8), sessionId: 'stream-captured-session', exitCode: 0 };
    });

    writePlanFile(tmpDir);

    const phase = new PlanPhase(
      aiRunner, createMockGitOperations() as any, plan,
      createTestConfig(),
    );

    await phase.run(ctx);
    expect(plan.getPhaseSessionId('plan')).toBe('stream-captured-session');
  });
});

describe('Session Resume — BuildPhase', () => {
  let tmpDir: string;
  let plan: PlanPersistence;
  let aiRunner: ReturnType<typeof createMockAIRunner>;

  const ctx: PhaseContext = {
    demand: createTestDemand(),
    branchName: 'feat/issue-42',
    pipelineMode: 'plan-mode',
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-resume-build-'));
    plan = new PlanPersistence(tmpDir, 42);
    plan.ensureDir();
    aiRunner = createMockAIRunner();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('BuildPhase resumes from previous session on retry', async () => {
    plan.writeProgress({
      displayId: 42,
      title: 'Test',
      branchName: 'feat/42',
      currentPhase: 'build',
      phases: {
        plan: { status: 'completed' },
        build: { status: 'failed', sessionId: 'build-session-abc' },
      },
    });

    const git = createMockGitOperations();
    git.hasChanges.mockResolvedValue(true);

    const phase = new BuildPhase(
      aiRunner, git as any, plan,
      createTestConfig(),
    );

    await phase.run(ctx);

    const runCall = aiRunner.run.mock.calls[0][0];
    expect(runCall.sessionId).toBe('build-session-abc');
    expect(runCall.continueSession).toBe(true);
  });
});
