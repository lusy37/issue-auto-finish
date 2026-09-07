/**
 * BuildPhase 不同 AI 输出场景测试 — 使用 ScriptedAIRunner。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BuildPhase } from '../../../src/phases/BuildPhase.js';
import { PlanPersistence } from '../../../src/persistence/PlanPersistence.js';
import { ScriptedAIRunner, successScript, failureScript } from '../../helpers/scripted-ai-runner.js';
import {
  createMockGitOperations,
  createTestConfig,
} from '../../helpers/mock-factories.js';
import type { PhaseContext } from '../../../src/phases/BasePhase.js';

vi.mock('../../../src/knowledge/index.js', () => ({
  getProjectKnowledge: vi.fn().mockReturnValue(null),
}));

const ISSUE_IID = 42;

function buildPhaseCtx(overrides?: Partial<PhaseContext>): PhaseContext {
  return {
    demand: {
      demandId: '42',
      title: 'Test Issue',
      description: 'Implement feature',
      sourceRef: { displayId: String(ISSUE_IID), source: 'github' as const, externalId: '200' },
    },
    branchName: 'feat/issue-42',
    pipelineMode: 'plan-mode',
    ...overrides,
  };
}

describe('BuildPhase Scenarios (ScriptedAIRunner)', () => {
  let dataDir: string;
  let wtPlan: PlanPersistence;
  let mockGit: ReturnType<typeof createMockGitOperations>;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'build-phase-'));
    wtPlan = new PlanPersistence(dataDir, ISSUE_IID);
    wtPlan.ensureDir();
    mockGit = createMockGitOperations();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function createPhase(runner: ScriptedAIRunner) {
    return new BuildPhase(
      runner,
      mockGit as any,
      wtPlan,
      createTestConfig(),
    );
  }

  it('should succeed when AI produces code changes', async () => {
    mockGit.hasChanges.mockResolvedValue(true);
    const runner = new ScriptedAIRunner([successScript()]);

    const phase = createPhase(runner);
    const intent = await phase.run(buildPhaseCtx());

    expect(intent.kind).toBe('completed');
  });

  it('should fail when AI succeeds but no code changes', async () => {
    mockGit.hasChanges.mockResolvedValue(false);
    const runner = new ScriptedAIRunner([successScript()]);

    const phase = createPhase(runner);
    const intent = await phase.run(buildPhaseCtx());

    expect(intent.kind).toBe('failed');
    if (intent.kind !== 'failed') throw new Error('Expected failed intent');
    expect(intent.error.message).toMatch(/未产生任何代码变更/);
    expect(intent.error.retryable).toBe('hard-no-auto');
  });

  it('should return failed outcome when AI fails', async () => {
    const runner = new ScriptedAIRunner([failureScript('Build timeout')]);

    const phase = createPhase(runner);
    const intent = await phase.run(buildPhaseCtx());

    expect(intent.kind).toBe('failed');
    if (intent.kind !== 'failed') throw new Error('Expected failed intent');
    expect(intent.error).toBeDefined();
    expect(intent.error.message).toBeTruthy();
  });

  it('should include fix context in prompt when fixContext is provided', async () => {
    mockGit.hasChanges.mockResolvedValue(true);
    const runner = new ScriptedAIRunner([successScript()]);

    const phase = createPhase(runner);
    await phase.run(buildPhaseCtx({
      fixContext: {
        iteration: 2,
        verifyFailures: ['Lint failed', 'Test failed'],
        rawReport: 'Detailed error report...',
      },
    }));

    // The prompt passed to AI should contain fix context info
    const prompt = runner.runCalls[0].prompt;
    expect(prompt).toContain('Lint failed');
    expect(prompt).toContain('Test failed');
  });

  it('should not include fix context in normal build prompt', async () => {
    mockGit.hasChanges.mockResolvedValue(true);
    const runner = new ScriptedAIRunner([successScript()]);

    const phase = createPhase(runner);
    await phase.run(buildPhaseCtx());

    // Prompt should NOT contain fix-related terms
    const prompt = runner.runCalls[0].prompt;
    expect(prompt).not.toContain('verifyFailures');
  });
});
