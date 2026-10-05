import * as codec from '../../../src/verify/VerifyResultCodec.js';
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
import { ScriptedAIRunner, successScript, failureScript } from '../../helpers/scripted-ai-runner.js';
import { verifyAgentOutput } from '../../helpers/verify-result.js';
import {
  createMockGitOperations,
  createTestConfig,
} from '../../helpers/mock-factories.js';
import type { PhaseContext } from '../../../src/phases/BasePhase.js';

vi.mock('../../../src/verify/VerifyResultCodec.js', { spy: true });

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

const PASSING_REPORT = '# 验证报告\n\nLint、Build、Test 均已执行并通过，本次代码检查和关联测试满足进入下一阶段的条件。';
const FAILING_REPORT = '# 验证报告\n\nLint 与 Build 已完成，但 Test 执行失败，存在未通过的检查项，需要回到 build 修复后重新验证。';
const PASSING_OUTPUT = verifyAgentOutput({ reportMarkdown: PASSING_REPORT });
const FAILING_OUTPUT = verifyAgentOutput({ test: 'failed', reportMarkdown: FAILING_REPORT });

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
    vi.clearAllMocks();
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
      successScript({ output: PASSING_OUTPUT }),
    ]);

    const phase = createPhase(runner);
    const intent = await phase.run(buildPhaseCtx());

    expect(intent.kind).toBe('completed');
  });

  it('should return requestRetryFrom("build") when verify report fails', async () => {
    const runner = new ScriptedAIRunner([
      successScript({ output: FAILING_OUTPUT }),
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
      successScript({ output: FAILING_OUTPUT }),
    ]);

    const phase = createPhase(runner);
    const intent = await phase.run(buildPhaseCtx());

    expect(intent.kind).toBe('requestRetryFrom');
    if (intent.kind !== 'requestRetryFrom') throw new Error('Expected requestRetryFrom intent');
    expect(intent.context?.rawReport).toBeDefined();
  });

  it('关闭自动修复后，验证失败保留报告并禁止自动重试', async () => {
    const runner = new ScriptedAIRunner([
      successScript({ output: FAILING_OUTPUT }),
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
      successScript({ output: PASSING_OUTPUT }),
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
      successScript({ output: reportWithoutTodo }),
    ]);

    const phase = createPhase(runner, {
      verifyFixLoop: { enabled: true, maxIterations: 3 },
    });
    const intent = await phase.run(buildPhaseCtx());

    expect(intent.kind).toBe('failed');
    if (intent.kind !== 'failed') throw new Error('应拒绝不完整报告');
    expect(intent.error.retryable).toBe('hard-no-auto');
    expect(intent.error.message).toContain('JSON');
  });
  it('每次调用只解析一次，复用阶段实例也不采用上次报告', async () => {
    const runner = new ScriptedAIRunner([
      successScript({ output: PASSING_OUTPUT }),
      successScript({ output: FAILING_OUTPUT }),
      successScript({ output: '无效 JSON' }),
      successScript({ output: PASSING_OUTPUT }),
    ]);
    const phase = createPhase(runner);
    const parse = vi.mocked(codec.parseVerifyAgentOutput);
    expect((await phase.run(buildPhaseCtx())).kind).toBe('completed');
    expect(parse).toHaveBeenCalledTimes(1);
    const failed = await phase.run(buildPhaseCtx());
    expect(failed).toMatchObject({ kind: 'requestRetryFrom', context: { rawReport: FAILING_REPORT } });
    expect(parse).toHaveBeenCalledTimes(2);
    expect((await phase.run(buildPhaseCtx())).kind).toBe('failed');
    expect(parse).toHaveBeenCalledTimes(3);
    expect((await phase.run(buildPhaseCtx())).kind).toBe('completed');
    expect(parse).toHaveBeenCalledTimes(4);
  });

});
