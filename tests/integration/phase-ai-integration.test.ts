/**
 * 跨层集成测试 — 真实 Phase + ScriptedAIRunner + 真实 PlanPersistence。
 *
 * 验证"阶段 + AI Runner"的端到端交互，
 * 不涉及编排器（PipelineOrchestrator），聚焦单阶段行为。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PlanPhase } from '../../src/phases/PlanPhase.js';
import { BuildPhase } from '../../src/phases/BuildPhase.js';
import { VerifyPhase } from '../../src/phases/VerifyPhase.js';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import {
  ScriptedAIRunner,
  successScript,
  failureScript,
  writeArtifact,
} from '../helpers/scripted-ai-runner.js';
import {
  createMockGitOperations,
  createTestConfig,
} from '../helpers/mock-factories.js';
import type { PhaseContext } from '../../src/phases/BasePhase.js';

vi.mock('../../src/knowledge/index.js', () => ({
  getProjectKnowledge: vi.fn().mockReturnValue(null),
}));

const ISSUE_IID = 42;

function buildPhaseCtx(overrides?: Partial<PhaseContext>): PhaseContext {
  return {
    demand: {
      demandId: '42',
      title: 'Integration Test Issue',
      description: 'Test full phase lifecycle',
      sourceRef: { displayId: String(ISSUE_IID), source: 'github' as const, externalId: '200' },
    },
    branchName: 'feat/issue-42',
    pipelineMode: 'plan-mode',
    ...overrides,
  };
}

describe('Phase-AI Integration', () => {
  let dataDir: string;
  let wtPlan: PlanPersistence;
  const config = createTestConfig();

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'phase-ai-'));
    wtPlan = new PlanPersistence(dataDir, ISSUE_IID);
    wtPlan.ensureDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  // ── Plan → success ──

  it('PlanPhase: should write artifact via sideEffect and complete', async () => {
    const planContent = 'A'.repeat(100);
    const runner = new ScriptedAIRunner([
      successScript({ output: planContent }),
    ]);

    const phase = new PlanPhase(
      runner,
      createMockGitOperations() as any,
      wtPlan,
      config,
    );

    const intent = await phase.run(buildPhaseCtx());
    expect(intent.kind).toBe('completed');

    const artifactPath = path.join(dataDir, '.claude-plan', `issue-${ISSUE_IID}`, '01-plan.md');
    expect(existsSync(artifactPath)).toBe(true);
    expect(readFileSync(artifactPath, 'utf-8')).toBe(planContent);

    expect(runner.runCalls[0].mode).toBe('plan');
    expect(runner.runCalls[0].phaseName).toBe('plan');
  });

  // ── Build → validates changes ──

  it('BuildPhase: should succeed with git changes', async () => {
    const mockGit = createMockGitOperations();
    mockGit.hasChanges.mockResolvedValue(true);

    const runner = new ScriptedAIRunner([successScript()]);
    const phase = new BuildPhase(runner, mockGit as any, wtPlan, config);

    const intent = await phase.run(buildPhaseCtx());
    expect(intent.kind).toBe('completed');
    expect(mockGit.hasChanges).toHaveBeenCalled();
  });

  it('BuildPhase: should fail without git changes', async () => {
    const mockGit = createMockGitOperations();
    mockGit.hasChanges.mockResolvedValue(false);

    const runner = new ScriptedAIRunner([successScript()]);
    const phase = new BuildPhase(runner, mockGit as any, wtPlan, config);

    const intent = await phase.run(buildPhaseCtx());
    expect(intent.kind).toBe('failed');
    if (intent.kind === 'failed') {
      expect(intent.error.message).toMatch(/未产生任何代码变更/);
    }
  });

  // ── Verify → parses report ──

  it('VerifyPhase: should return completed when report passes', async () => {
    const report = `# 验证报告\n\n**Lint 结果**: 通过\n**Build 结果**: 通过\n**Test 结果**: 通过\n\n## 总结\n所有检查均通过。`;

    const runner = new ScriptedAIRunner([
      successScript(undefined, writeArtifact(ISSUE_IID, '02-verify-report.md', report)),
    ]);
    const phase = new VerifyPhase(runner, createMockGitOperations() as any, wtPlan, config);

    const intent = await phase.run(buildPhaseCtx());
    expect(intent.kind).toBe('completed');
  });

  it('VerifyPhase: should return requestRetryFrom build when test fails', async () => {
    const report = `# 验证报告\n\n**Lint 结果**: 通过\n**Build 结果**: 通过\n**Test 结果**: 失败\n\n## 总结\n验证失败。`;

    const runner = new ScriptedAIRunner([
      successScript(undefined, writeArtifact(ISSUE_IID, '02-verify-report.md', report)),
    ]);
    const phase = new VerifyPhase(runner, createMockGitOperations() as any, wtPlan, config);

    const intent = await phase.run(buildPhaseCtx());
    expect(intent.kind).toBe('requestRetryFrom');
    if (intent.kind === 'requestRetryFrom') {
      expect(intent.targetPhaseId).toBe('build');
      expect(intent.reason).toBe('verify-failed');
      const failures = intent.context?.verifyFailures as readonly string[] | undefined;
      expect(failures).toContain('测试未通过');
    }
  });

  // ── Multi-phase sequence ──

  it('should run Plan → Build → Verify in sequence', async () => {
    const mockGit = createMockGitOperations();
    mockGit.hasChanges.mockResolvedValue(true);

    const planRunner = new ScriptedAIRunner([
      successScript({ output: 'B'.repeat(100) }),
    ]);
    const buildRunner = new ScriptedAIRunner([successScript()]);
    const verifyReport = `# 验证报告\n\n**Lint 结果**: 通过\n**Build 结果**: 通过\n**Test 结果**: 通过\n\n## 总结\n通过`;
    const verifyRunner = new ScriptedAIRunner([
      successScript(undefined, writeArtifact(ISSUE_IID, '02-verify-report.md', verifyReport)),
    ]);

    const ctx = buildPhaseCtx();

    const planPhase = new PlanPhase(planRunner, createMockGitOperations() as any, wtPlan, config);
    expect((await planPhase.run(ctx)).kind).toBe('completed');

    const buildPhase = new BuildPhase(buildRunner, mockGit as any, wtPlan, config);
    expect((await buildPhase.run(ctx)).kind).toBe('completed');

    const verifyPhase = new VerifyPhase(verifyRunner, createMockGitOperations() as any, wtPlan, config);
    expect((await verifyPhase.run(ctx)).kind).toBe('completed');
  });

  // ── Error propagation ──

  it('should propagate AI failure as failed Intent', async () => {
    const runner = new ScriptedAIRunner([
      failureScript('Authentication failed: invalid API key'),
    ]);

    const phase = new PlanPhase(runner, createMockGitOperations() as any, wtPlan, config);

    const intent = await phase.run(buildPhaseCtx());
    expect(intent.kind).toBe('failed');
    if (intent.kind === 'failed') {
      expect(intent.error.message).toMatch(/Authentication failed/);
      expect(['hard', 'hard-no-auto']).toContain(intent.error.retryable);
    }
  });
});
