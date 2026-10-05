/**
 * 跨层集成测试 — 真实 Phase + ScriptedAIRunner + 真实 PlanPersistence。
 *
 * 验证"阶段 + AI Runner"的端到端交互，
 * 不涉及编排器（IssueService），聚焦单阶段行为。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PlanPhase } from '../../src/phases/PlanPhase.js';
import { VerifyPhase } from '../../src/phases/VerifyPhase.js';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import {
  ScriptedAIRunner,
  successScript,
  failureScript,
} from '../helpers/scripted-ai-runner.js';
import {
  createMockGitOperations,
  createTestConfig,
} from '../helpers/mock-factories.js';
import { verifyAgentOutput } from '../helpers/verify-result.js';
import type { PhaseContext } from '../../src/phases/BasePhase.js';

vi.mock('../../src/knowledge/index.js', () => ({
  getProjectKnowledge: vi.fn().mockReturnValue(null),
}));

const ISSUE_IID = 42;

function buildPhaseCtx(overrides?: Partial<PhaseContext>): PhaseContext {
  return {
    demand: { createdAt: '2026-09-20T00:00:00Z',
      demandId: '42',
      title: 'Integration Test Issue',
      description: 'Test full phase lifecycle',
      sourceRef: { displayId: String(ISSUE_IID), source: 'github-issue' as const, externalId: '200' },
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

  it('计划阶段返回已校验内容，由编排器统一落盘', async () => {
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
    if (intent.kind !== 'completed') throw new Error('应返回成功计划');
    expect(intent.planContent?.description).toBe(planContent);
    expect(intent.planContent?.tasks[0].instructions).toBe(planContent);

    const artifactPath = path.join(process.env.DATA_DIR!, 'issues', String(ISSUE_IID), 'artifacts', '01-plan.md');
    expect(existsSync(artifactPath)).toBe(false);

    expect(runner.runCalls[0].mode).toBe('plan');
    expect(runner.runCalls[0].phaseName).toBe('plan');
  });

  // ── Verify → parses structured result and writes display report ──

  it('VerifyPhase: should return completed when report passes', async () => {
    const runner = new ScriptedAIRunner([
      successScript({ output: verifyAgentOutput({ reportMarkdown: '# 验证报告\n\nLint、Build、Test 均已执行并通过，本次代码检查和关联测试满足进入下一阶段的条件。' }) }),
    ]);
    const phase = new VerifyPhase(runner, createMockGitOperations() as any, wtPlan, config);

    const intent = await phase.run(buildPhaseCtx());
    expect(intent.kind).toBe('completed');
  });

  it('VerifyPhase: should return requestRetryFrom build when test fails', async () => {
    const runner = new ScriptedAIRunner([
      successScript({ output: verifyAgentOutput({ test: 'failed', reportMarkdown: '# 验证报告\n\nTest 执行失败，存在未通过的检查项，需要回到 build 修复后重新验证。' }) }),
    ]);
    const phase = new VerifyPhase(runner, createMockGitOperations() as any, wtPlan, config);

    const intent = await phase.run(buildPhaseCtx());
    expect(intent.kind).toBe('requestRetryFrom');
    if (intent.kind === 'requestRetryFrom') {
      expect(intent.targetPhaseId).toBe('build');
      expect(intent.reason).toBe('verify-failed');
      const failures = intent.context?.verifyFailures as readonly string[] | undefined;
      expect(failures).toContain('Test 检查失败：Test 失败');
    }
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
