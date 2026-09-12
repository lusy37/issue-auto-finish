import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { executePhaseLoop } from '../../src/orchestrator/steps/PhaseLoopStep.js';
import { IssueTracker } from '../../src/tracker/IssueTracker.js';
import { IssueState } from '../../src/tracker/IssueState.js';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import { buildPlanModePipeline, createLifecycleManager } from '../../src/pipeline/PipelineDefinition.js';
import { resetKnowledgeCache } from '../../src/knowledge/KnowledgeLoader.js';
import { createMockGitOperations, createMockOrchestratorDeps, createTestConfig, createTestIssue } from '../helpers/mock-factories.js';
import type { AIRunner, RunOptions } from '../../src/ai-runner/AIRunner.js';
import type { IssueProcessingContext } from '../../src/orchestrator/IssueProcessingContext.js';

// 计划、构建、验证、状态机和落盘都使用实际实现；本组只隔离浏览器阶段和外部平台。
vi.mock('../../src/phases/PhaseFactory.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/phases/PhaseFactory.js')>();
  return {
    ...original,
    createPhase: (...args: Parameters<typeof original.createPhase>) => args[0] === 'uat'
      ? { run: async () => ({ kind: 'completed' }), getResultFiles: () => [] }
      : original.createPhase(...args),
  };
});

let dir: string;
beforeEach(() => {
  const root = path.resolve('.iaf-mini/repair-tests');
  fs.mkdirSync(root, { recursive: true });
  dir = fs.mkdtempSync(path.join(root, '流程配置 '));
  vi.stubEnv('DATA_DIR', dir);
  resetKnowledgeCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetKnowledgeCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(options: { review?: boolean; label?: boolean; max?: number; loop?: boolean; failVerify?: boolean } = {}) {
  const config = createTestConfig();
  config.review.enabled = options.review ?? false;
  config.preview.enabled = false;
  config.e2e.enabled = true;
  config.verifyFixLoop.enabled = options.loop ?? true;
  config.verifyFixLoop.maxIterations = options.max ?? 3;
  const pipelineDef = buildPlanModePipeline({ e2eEnabled: true });
  const managers = new Map([[pipelineDef.mode, createLifecycleManager(pipelineDef)]]);
  const tracker = new IssueTracker(dir, managers);
  const demand = {
    demandId: 'gh-1', sourceRef: { source: 'github-issue' as const, externalId: '1', displayId: '1' },
    title: '流程配置验证', description: '验证配置驱动的真实阶段循环', createdAt: new Date().toISOString(),
  };
  const record = tracker.create({ state: IssueState.Pending, pipelineMode: 'plan-mode', demandSpec: demand, branchName: 'feat/issue-1' });
  tracker.initPhaseProgress(1, pipelineDef);
  const plan = new PlanPersistence(dir, 1);
  plan.writeProgress(plan.createInitialProgress(1, demand.title, record.branchName, pipelineDef));
  const calls: RunOptions[] = [];
  const runner: AIRunner = {
    killAll() {}, killByWorkDir() { return 0; },
    async run(opts) {
      calls.push(opts);
      if (opts.phaseName === 'verify') plan.writeFile('02-verify-report.md',
        `# 验证报告\n\n**Lint 结果**: 通过\n**Build 结果**: 通过\n**Test 结果**: ${options.failVerify ? '失败' : '通过'}\n\n## 总结\n${options.failVerify ? '失败：测试不符合要求，需要修复。' : '所有检查通过，待办全部完成。'}\n`);
      return { success: true, exitCode: 0, output: '# 完整实施计划\n\n目标是验证审核和自动修复配置真正进入阶段执行逻辑。\n\n- [x] 修改页面\n- [x] 运行验证\n- [x] 完成验收\n' };
    },
  };
  const git = createMockGitOperations();
  git.hasChanges.mockResolvedValue(true);
  const deps = createMockOrchestratorDeps({ config, tracker, aiRunner: runner, shouldAutoApprove: () => options.label ?? false });
  const ctx = {
    issue: createTestIssue({ number: 1 }), branchName: record.branchName,
    wtCtx: { workDir: dir, issueIid: 1 }, record, isRetry: false, pipelineDef, demand,
    phaseCtx: { demand, branchName: record.branchName, pipelineMode: 'plan-mode' },
  } as IssueProcessingContext;
  return { config, deps, ctx, calls, plan, managers, drive: () => executePhaseLoop(ctx, deps, git as never, plan) };
}

describe('配置进入实际阶段循环', () => {
  it.each([
    { review: false, label: true, source: 'configuration' },
    { review: true, label: true, source: 'label' },
  ])('新计划保存后按 $source 通过，并持久化审核来源', async options => {
    const f = fixture(options);
    expect(await f.drive()).toMatchObject({ paused: false });
    expect(f.plan.isArtifactReady('01-plan.md')).toBe(true);
    const restored = new IssueTracker(dir, f.managers).get(1)!;
    expect(restored.orchestrationState?.kind).toBe('pipeline-completed');
    expect(restored.phaseHistory).toContainEqual(expect.objectContaining({ phaseId: 'review', outcome: 'gate-approved', approvalSource: options.source }));
    expect(f.calls.map(c => c.phaseName)).toEqual(['plan', 'build', 'verify']);
  });

  it('关闭审核后重启不会自动批准已在等待的计划', async () => {
    const f = fixture({ review: true });
    expect(await f.drive()).toMatchObject({ paused: true });
    expect(f.deps.tracker.get(1)?.orchestrationState?.kind).toBe('gate-waiting');
    f.config.review.enabled = false;
    f.deps.tracker = new IssueTracker(dir, f.managers);
    await f.drive();
    expect(f.calls.map(c => c.phaseName)).toEqual(['plan']);
    expect(f.deps.tracker.get(1)?.orchestrationState?.kind).toBe('gate-waiting');
  });

  it('完整计划保存失败时不能进入构建', async () => {
    const f = fixture();
    vi.spyOn(f.plan, 'writePlan').mockImplementationOnce(() => { throw new Error('计划落盘失败'); });
    await expect(f.drive()).rejects.toThrow('计划落盘失败');
    expect(f.calls.map(c => c.phaseName)).toEqual(['plan']);
    expect(f.deps.tracker.get(1)?.phaseHistory?.some(h => h.outcome === 'gate-approved')).toBe(false);
  });

  it.each([1, 3])('最多追加 %i 轮修复，超限后停在验证失败', async max => {
    const f = fixture({ max, failVerify: true });
    expect(await f.drive()).toMatchObject({ paused: true });
    expect(f.calls.filter(c => c.phaseName === 'build')).toHaveLength(max + 1);
    expect(f.calls.filter(c => c.phaseName === 'verify')).toHaveLength(max + 1);
    const record = f.deps.tracker.get(1)!;
    expect(record.orchestrationState).toMatchObject({ kind: 'pipeline-failed', failedAt: 'verify', retryable: 'manual' });
    expect(record.phaseHistory?.filter(h => h.outcome === 'retried-from')).toHaveLength(max);
    expect(record.phaseHistory?.some(h => h.phaseId === 'uat')).toBe(false);
  });

  it('关闭自动修复后不追加构建，也不进入验收或交付', async () => {
    const f = fixture({ loop: false, failVerify: true });
    expect(await f.drive()).toMatchObject({ paused: true });
    expect(f.calls.map(c => c.phaseName)).toEqual(['plan', 'build', 'verify']);
    expect(f.deps.tracker.get(1)?.orchestrationState).toMatchObject({ kind: 'pipeline-failed', failedAt: 'verify', retryable: 'manual' });
    expect(f.deps.tracker.get(1)?.phaseHistory?.some(h => h.phaseId === 'uat')).toBe(false);
  });

  it('服务重启后从落盘历史继续计算修复次数', async () => {
    const f = fixture({ max: 3, failVerify: true });
    f.deps.consumePendingAction = () => f.deps.tracker.get(1)?.phaseHistory?.some(h => h.outcome === 'retried-from') ? 'abort' : undefined;
    await expect(f.drive()).rejects.toThrow();
    expect(f.calls.filter(c => c.phaseName === 'verify')).toHaveLength(1);
    f.deps.consumePendingAction = undefined;
    f.deps.tracker = new IssueTracker(dir, f.managers);
    expect(await f.drive()).toMatchObject({ paused: true });
    expect(f.calls.filter(c => c.phaseName === 'build')).toHaveLength(4);
    expect(f.calls.filter(c => c.phaseName === 'verify')).toHaveLength(4);
    expect(f.deps.tracker.get(1)?.phaseHistory?.filter(h => h.outcome === 'retried-from')).toHaveLength(3);
  });
});
