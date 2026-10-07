import { runVerificationCommands } from '../../src/verify/VerificationCommands.js';
import { verificationChecks } from '../helpers/verify-result.js';
vi.mock('../../src/verify/VerificationCommands.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/verify/VerificationCommands.js')>();
  return { ...original, runVerificationCommands: vi.fn(async options => {
    const { verificationChecks } = await import('../helpers/verify-result.js');
    return verificationChecks({ commands: options.commands });
  }) };
});

/** 阶段意图契约：验证完成、请求集成修复和超时失败的实际返回结构。
 * 审核 interrupt 与任务图恢复由原生工作流集成测试覆盖。
 */
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import type { PhaseContext } from '../../src/phases/BasePhase.js';
import { PlanPhase } from '../../src/phases/PlanPhase.js';
import { VerifyPhase } from '../../src/phases/VerifyPhase.js';
import {
createMockGitOperations,
createTestConfig,
} from '../helpers/mock-factories.js';
import {
ScriptedAIRunner,
successScript
} from '../helpers/scripted-ai-runner.js';
import { verifyAgentOutput } from '../helpers/verify-result.js';

vi.mock('../../src/knowledge/index.js', () => ({
  getProjectKnowledge: vi.fn().mockReturnValue(null),
}));

let mockDataDir: string;
vi.mock('../../src/paths.js', () => ({
  resolveDataDir: () => mockDataDir,
}));

const ISSUE_IID = 1001;
const MIN_CONTENT = 'A'.repeat(80);

function buildPhaseCtx(overrides?: Partial<PhaseContext>): PhaseContext {
  return {
    demand: { createdAt: '2026-09-20T00:00:00Z',
      demandId: String(ISSUE_IID),
      title: 'Test Issue',
      description: 'Implement feature',
      sourceRef: { displayId: String(ISSUE_IID), source: 'github-issue' as const, externalId: '200' },
    },
    branchName: `feat/issue-${ISSUE_IID}`,
    pipelineMode: 'plan-mode',
    ...overrides,
  };
}

describe('Phase Intent Contracts (INT-1~8)', () => {
  let dataDir: string;
  let wtPlan: PlanPersistence;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'phase-intents-'));
    mockDataDir = mkdtempSync(path.join(tmpdir(), 'phase-intents-global-'));
    wtPlan = new PlanPersistence(dataDir, ISSUE_IID);
    wtPlan.ensureDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(mockDataDir, { recursive: true, force: true });
  });

  // ──────────────────────────────────────────────────────────
  // INT-1：plan 完成 → CompletedIntent
  // ──────────────────────────────────────────────────────────
  it('INT-1: plan 阶段成功完成 → CompletedIntent', async () => {
    const planContent = '# Plan\n\n' + MIN_CONTENT;
    const runner = new ScriptedAIRunner([
      successScript({ output: planContent }),
    ]);
    const phase = new PlanPhase(
      runner,
      createMockGitOperations() as any,
      wtPlan,
      createTestConfig(),
    );

    const intent = await phase.run(buildPhaseCtx());

    expect(intent.kind).toBe('completed');
    if (intent.kind !== 'completed') throw new Error('Expected completed');
    expect(intent.output).toBeDefined();
    expect(intent.artifacts?.some(a => a.filename === '01-plan.md')).toBe(true);
  });

  // ──────────────────────────────────────────────────────────
  // INT-4：verify 失败 → RequestRetryFromIntent('build')
  // ──────────────────────────────────────────────────────────
  it('INT-4: verify 报告失败 → RequestRetryFromIntent("build")', async () => {
    vi.mocked(runVerificationCommands).mockResolvedValueOnce(verificationChecks({ test: 'failed' }));
    const runner = new ScriptedAIRunner([
      successScript({ output: verifyAgentOutput({ test: 'failed', reportMarkdown: '# 验证报告\n\nTest 执行失败，存在未通过的检查项，需要回到 build 修复后重新验证。' }) }),
    ]);
    const phase = new VerifyPhase(
      runner,
      createMockGitOperations() as any,
      wtPlan,
      createTestConfig(),
    );

    const intent = await phase.run(buildPhaseCtx());

    expect(intent.kind).toBe('requestRetryFrom');
    if (intent.kind !== 'requestRetryFrom') throw new Error('Expected requestRetryFrom');
    expect(intent.targetPhaseId).toBe('build');
    expect(intent.reason).toBe('verify-failed');
    expect(intent.context?.verifyFailures).toBeDefined();
  });

  // ──────────────────────────────────────────────────────────
  // INT-6：超时 + active → FailedIntent.error.retryable === 'soft'
  // ──────────────────────────────────────────────────────────
  it('INT-6: 超时但 AI 仍 active → FailedIntent.error.retryable === "soft"', async () => {
    const runner = new ScriptedAIRunner([
      {
        result: {
          success: false,
          output: 'partial output during active execution',
          errorMessage: 'AI runner timed out (wall-clock)',
          exitCode: null,
          timeoutType: 'wall-clock',
          wasActiveAtTimeout: true,
        },
      },
    ]);
    const phase = new PlanPhase(
      runner,
      createMockGitOperations() as any,
      wtPlan,
      createTestConfig(),
    );

    const intent = await phase.run(buildPhaseCtx());

    expect(intent.kind).toBe('failed');
    if (intent.kind !== 'failed') throw new Error('Expected failed');
    expect(intent.error.retryable).toBe('soft');
  });

  // ──────────────────────────────────────────────────────────
  // INT-7：超时但 AI 非 active → FailedIntent.error.retryable === 'hard'
  // ──────────────────────────────────────────────────────────
  it('INT-7: 超时但 AI 非 active → FailedIntent.error.retryable === "hard"', async () => {
    const runner = new ScriptedAIRunner([
      {
        result: {
          success: false,
          output: '',
          errorMessage: 'AI runner timed out (idle)',
          exitCode: null,
          timeoutType: 'idle',
          // wasActiveAtTimeout omitted → default falsy
        },
      },
    ]);
    const phase = new PlanPhase(
      runner,
      createMockGitOperations() as any,
      wtPlan,
      createTestConfig(),
    );

    const intent = await phase.run(buildPhaseCtx());

    expect(intent.kind).toBe('failed');
    if (intent.kind !== 'failed') throw new Error('Expected failed');
    expect(intent.error.retryable).toBe('hard');
  });
});
