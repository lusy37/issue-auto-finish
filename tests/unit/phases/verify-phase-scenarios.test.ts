import { resolveIssueArtifactsDir } from '../../../src/persistence/ArtifactPaths.js';
/**
 * VerifyPhase 报告解析场景测试 — 使用 ScriptedAIRunner。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VerifyPhase } from '../../../src/phases/VerifyPhase.js';
import { PlanPersistence } from '../../../src/persistence/PlanPersistence.js';
import { ScriptedAIRunner, successScript, failureScript, writeArtifact } from '../../helpers/scripted-ai-runner.js';
import {
  createMockGitOperations,
  createTestConfig,
} from '../../helpers/mock-factories.js';
import type { PhaseContext } from '../../../src/phases/BasePhase.js';

vi.mock('../../../src/knowledge/index.js', () => ({
  getProjectKnowledge: vi.fn().mockReturnValue(null),
}));

const ISSUE_IID = 42;

function buildPhaseCtx(): PhaseContext {
  return {
    demand: { createdAt: '2026-09-20T00:00:00Z',
      demandId: '42',
      title: 'Test Issue',
      description: 'Verify feature',
      sourceRef: { displayId: String(ISSUE_IID), source: 'github-issue' as const, externalId: '200' },
    },
    branchName: 'feat/issue-42',
    pipelineMode: 'plan-mode',
  };
}

const PASSING_REPORT = `# 验证报告

**Lint 结果**: 通过
**Build 结果**: 通过
**Test 结果**: 通过

## Lint 检查
- [x] ESLint 通过

## 构建
- [x] TypeScript 编译通过

## 测试
- [x] 单元测试通过

## 总结
所有检查项均已通过。
`;

const FAILING_REPORT = `# 验证报告

**Lint 结果**: 通过
**Build 结果**: 通过
**Test 结果**: 失败

## 测试
- 2 个单元测试失败

## 总结
验证失败，存在未通过的检查项。
`;

describe('VerifyPhase Scenarios (ScriptedAIRunner)', () => {
  let dataDir: string;
  let wtPlan: PlanPersistence;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'verify-phase-'));
    wtPlan = new PlanPersistence(dataDir, ISSUE_IID);
    wtPlan.ensureDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function createPhase(runner: ScriptedAIRunner, configOverrides?: Record<string, unknown>) {
    return new VerifyPhase(
      runner,
      createMockGitOperations() as any,
      wtPlan,
      createTestConfig(configOverrides),
    );
  }

  it('should return completed when verify report passes', async () => {
    const runner = new ScriptedAIRunner([
      successScript(undefined, writeArtifact(ISSUE_IID, '02-verify-report.md', PASSING_REPORT)),
    ]);

    const phase = createPhase(runner);
    const intent = await phase.run(buildPhaseCtx());

    expect(intent.kind).toBe('completed');
  });

  it('should return requestRetryFrom("build") when verify report fails', async () => {
    const runner = new ScriptedAIRunner([
      successScript(undefined, writeArtifact(ISSUE_IID, '02-verify-report.md', FAILING_REPORT)),
    ]);

    const phase = createPhase(runner);
    const intent = await phase.run(buildPhaseCtx());

    expect(intent.kind).toBe('requestRetryFrom');
    if (intent.kind !== 'requestRetryFrom') throw new Error('Expected requestRetryFrom intent');
    expect(intent.targetPhaseId).toBe('build');
    expect(intent.reason).toBe('verify-failed');
    expect(intent.context).toBeDefined();
    expect(Array.isArray(intent.context?.verifyFailures)).toBe(true);
    expect((intent.context!.verifyFailures as string[]).length).toBeGreaterThan(0);
  });

  it('should attach failure context for build retry', async () => {
    const runner = new ScriptedAIRunner([
      successScript(undefined, writeArtifact(ISSUE_IID, '02-verify-report.md', FAILING_REPORT)),
    ]);

    const phase = createPhase(runner);
    const intent = await phase.run(buildPhaseCtx());

    expect(intent.kind).toBe('requestRetryFrom');
    if (intent.kind !== 'requestRetryFrom') throw new Error('Expected requestRetryFrom intent');
    expect(intent.context?.rawReport).toBeDefined();
  });

  it('关闭自动修复后，验证失败保留报告并禁止自动重试', async () => {
    const runner = new ScriptedAIRunner([
      successScript(undefined, writeArtifact(ISSUE_IID, '02-verify-report.md', FAILING_REPORT)),
    ]);
    const phase = createPhase(runner, { verifyFixLoop: { enabled: false, maxIterations: 3 } });
    const intent = await phase.run(buildPhaseCtx());
    expect(intent).toMatchObject({ kind: 'failed', error: { retryable: 'hard-no-auto', rawOutput: FAILING_REPORT } });
    expect(readFileSync(path.join(process.env.DATA_DIR!, 'issues', String(ISSUE_IID), 'artifacts', '02-verify-report.md'), 'utf8')).toBe(FAILING_REPORT);
    expect(runner.runCalls).toHaveLength(1);
  });

  it('should return failed intent when AI fails', async () => {
    const runner = new ScriptedAIRunner([failureScript('Verify process crashed')]);

    const phase = createPhase(runner);
    const intent = await phase.run(buildPhaseCtx());

    expect(intent.kind).toBe('failed');
    if (intent.kind !== 'failed') throw new Error('Expected failed intent');
    expect(intent.error).toBeDefined();
  });

  it('should use plan-mode verify prompt', async () => {
    const runner = new ScriptedAIRunner([
      successScript(undefined, writeArtifact(ISSUE_IID, '02-verify-report.md', PASSING_REPORT)),
    ]);

    const phase = createPhase(runner);
    await phase.run(buildPhaseCtx());

    expect(runner.runCalls[0].phaseName).toBe('verify');
  });

  it.each(['-', '*'])('报告缺少明确命令结果时，不能凭 %s 格式待办推断验收通过', async (bullet) => {
    // 准备计划展示副本，确认其勾选状态不能替代本次检查结果。
    const planDir = resolveIssueArtifactsDir(ISSUE_IID);
    mkdirSync(planDir, { recursive: true });
    writeFileSync(path.join(planDir, '01-plan.md'), `# 计划\n\n${bullet} [x] 步骤一\n  ${bullet} [X] 步骤二\n${bullet} [ ] 步骤三\n`);

    const reportWithoutTodo = `# 验证报告\n\n## Lint\n- [x] 通过\n\n## 构建\n- [x] 通过\n\n## 测试\n- [x] 通过\n\n## 总结\n通过`;

    const runner = new ScriptedAIRunner([
      successScript(undefined, writeArtifact(ISSUE_IID, '02-verify-report.md', reportWithoutTodo)),
    ]);

    const phase = createPhase(runner, {
      verifyFixLoop: { enabled: true, maxIterations: 3 },
    });
    const intent = await phase.run(buildPhaseCtx());

    expect(intent.kind).toBe('failed');
    if (intent.kind !== 'failed') throw new Error('应拒绝不完整报告');
    expect(intent.error.retryable).toBe('hard-no-auto');
    expect(intent.error.message).toContain('缺少');
  });
});
