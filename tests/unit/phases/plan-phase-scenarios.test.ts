/**
 * PlanPhase 不同 AI 输出场景测试 — 使用 ScriptedAIRunner。
 *
 * 测试阶段逻辑对不同 AI 结果的处理，不涉及编排层。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PlanPhase } from '../../../src/phases/PlanPhase.js';
import { PlanPersistence } from '../../../src/persistence/PlanPersistence.js';
import {
  ScriptedAIRunner,
  successScript,
  failureScript,
  timeoutScript,
  writeArtifact,
} from '../../helpers/scripted-ai-runner.js';
import {
  createMockGitOperations,
  createTestConfig,
} from '../../helpers/mock-factories.js';
import type { PhaseContext } from '../../../src/phases/BasePhase.js';

// Mock knowledge (avoid file system side effects)
vi.mock('../../../src/knowledge/index.js', () => ({
  getProjectKnowledge: vi.fn().mockReturnValue(null),
}));

const ISSUE_IID = 42;

function buildPhaseCtx(): PhaseContext {
  return {
    demand: {
      demandId: '42',
      title: 'Test Issue',
      description: 'Add new feature X',
      sourceRef: { displayId: String(ISSUE_IID), source: 'github' as const, externalId: '200' },
    },
    branchName: 'feat/issue-42',
    pipelineMode: 'plan-mode',
  };
}

describe('PlanPhase Scenarios (ScriptedAIRunner)', () => {
  let dataDir: string;
  let wtPlan: PlanPersistence;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'plan-phase-'));
    wtPlan = new PlanPersistence(dataDir, ISSUE_IID);
    wtPlan.ensureDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function createPhase(runner: ScriptedAIRunner) {
    return new PlanPhase(
      runner,
      createMockGitOperations() as any,
      wtPlan,
      createTestConfig(),
    );
  }

  it('should succeed when AI writes plan artifact', async () => {
    const planContent = '# Implementation Plan\n\nThis is a detailed plan with enough content to pass validation.';
    const runner = new ScriptedAIRunner([
      successScript({ output: planContent }),
    ]);

    const phase = createPhase(runner);
    const intent = await phase.run(buildPhaseCtx());

    expect(intent.kind).toBe('completed');
    expect(runner.runCalls).toHaveLength(1);
    expect(runner.runCalls[0].mode).toBe('plan');
  });

  it('should return failed outcome when AI returns failure', async () => {
    const runner = new ScriptedAIRunner([
      failureScript('Model not available'),
    ]);

    const phase = createPhase(runner);
    const intent = await phase.run(buildPhaseCtx());

    expect(intent.kind).toBe('failed');
    if (intent.kind !== 'failed') throw new Error('Expected failed intent');
    expect(intent.error).toBeDefined();
  });

  it('should fail when AI succeeds but artifact is missing', async () => {
    // AI succeeds but does NOT write 01-plan.md
    const runner = new ScriptedAIRunner([
      successScript(),
    ]);

    const phase = createPhase(runner);
    const intent = await phase.run(buildPhaseCtx());

    expect(intent.kind).toBe('failed');
    if (intent.kind !== 'failed') throw new Error('Expected failed intent');
    expect(intent.error.message).toMatch(/计划内容为空或不完整/);
    expect(intent.error.retryable).toBe('hard-no-auto');
  });

  it('should fail when artifact is too small', async () => {
    // Write a tiny file (< MIN_ARTIFACT_BYTES = 50)
    const runner = new ScriptedAIRunner([
      successScript({ output: 'tiny' }),
    ]);

    const phase = createPhase(runner);
    const intent = await phase.run(buildPhaseCtx());

    expect(intent.kind).toBe('failed');
    if (intent.kind !== 'failed') throw new Error('Expected failed intent');
    expect(intent.error.message).toMatch(/计划内容为空或不完整/);
    expect(intent.error.retryable).toBe('hard-no-auto');
  });

  it('should mark hard-no-auto for permanent errors', async () => {
    const runner = new ScriptedAIRunner([
      failureScript('model not found: claude-99'),
    ]);

    const phase = createPhase(runner);
    const intent = await phase.run(buildPhaseCtx());

    expect(intent.kind).toBe('failed');
    if (intent.kind !== 'failed') throw new Error('Expected failed intent');
    expect(intent.error.retryable).toBe('hard-no-auto');
  });

  it('should classify timeout as soft (active) or hard', async () => {
    const runner = new ScriptedAIRunner([
      timeoutScript('wall-clock'),
    ]);

    const phase = createPhase(runner);
    const intent = await phase.run(buildPhaseCtx());

    expect(intent.kind).toBe('failed');
    if (intent.kind !== 'failed') throw new Error('Expected failed intent');
    // 超时未必是 active，可能是 soft 或 hard，但不是 hard-no-auto
    expect(['soft', 'hard']).toContain(intent.error.retryable);
  });

  it('should pass prompt to AI runner with plan mode', async () => {
    const runner = new ScriptedAIRunner([
      successScript({ output: 'A'.repeat(100) }),
    ]);

    const phase = createPhase(runner);
    await phase.run(buildPhaseCtx());

    expect(runner.runCalls[0].mode).toBe('plan');
    expect(runner.runCalls[0].prompt).toContain('Test Issue');
  });
});
