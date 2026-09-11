/**
 * 阶段 Intent 契约测试 — PR2 INT-1~8
 *
 * 锁定每个阶段在典型场景下返回的 Intent 形态。这是 PR3 编排器开发的契约：
 * 编排器只能依赖这些 Intent 形状，不能 dive 到阶段内部数据。
 *
 * INT 编号对应 plan-57159b05.plan.md 中的验证 case：
 *   - INT-1: plan 完成 → CompletedIntent
 *   - INT-2: review 阶段（编排器层概念，不是 BasePhase；由 PR3 GateAction 单测覆盖）
 *   - INT-3: release 检测出能力 → AwaitGateIntent('release-confirm')
 *   - INT-4: verify 失败 → RequestRetryFromIntent('build')
 *   - INT-5: uat 异步 → AwaitAsyncIntent
 *   - INT-6: 超时 + active → FailedIntent.error.retryable === 'soft'
 *   - INT-7: 超时 + 非 active → FailedIntent.error.retryable === 'hard'
 *   - INT-8: ACP 模式走 onInputRequired 回调，不影响 Intent
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PlanPhase } from '../../src/phases/PlanPhase.js';
import { VerifyPhase } from '../../src/phases/VerifyPhase.js';
import { UatPhase } from '../../src/phases/UatPhase.js';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import { ReleaseDetectCache } from '../../src/release/index.js';
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
import type { InputRequest } from '../../src/ai-runner/index.js';

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
    demand: {
      demandId: String(ISSUE_IID),
      title: 'Test Issue',
      description: 'Implement feature',
      sourceRef: { displayId: String(ISSUE_IID), source: 'github' as const, externalId: '200' },
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
    const failingReport = [
      '# 验证报告',
      '',
      '**Lint 结果**: 通过',
      '**Build 结果**: 通过',
      '**Test 结果**: 失败',
      '',
      '## 测试',
      '- 3 个单元测试失败',
      '',
      '## 总结',
      '验证失败，存在未通过的检查项。',
    ].join('\n');
    const runner = new ScriptedAIRunner([
      successScript(undefined, writeArtifact(ISSUE_IID, '02-verify-report.md', failingReport)),
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
