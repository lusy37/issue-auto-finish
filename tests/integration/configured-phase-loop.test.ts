import { runVerificationCommands } from '../../src/verify/VerificationCommands.js';
import { verificationChecks } from '../helpers/verify-result.js';
vi.mock('../../src/verify/VerificationCommands.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/verify/VerificationCommands.js')>();
  return { ...original, runVerificationCommands: vi.fn(async options => {
    const { verificationChecks } = await import('../helpers/verify-result.js');
    return verificationChecks({ commands: options.commands });
  }) };
});

// 本组隔离交付；真实浏览器凭证和平台幂等交付由 mini-workflow / dag-delivery 验证。
vi.mock('../../src/orchestrator/steps/DeliverIssueStep.js', () => ({ deliverIssueStep: async (ctx: any, deps: any) => { deps.tracker.transaction(ctx.issue.number, (record: any) => { record.lifecycle = { kind: 'completed' }; record.deliveryPending = false; }); } }));
import { AsyncMutex } from '../../src/utils/AsyncMutex.js';
import { graphFixture, git as realGit } from '../helpers/dag-repository.js';
import { GitOperations } from '../../src/git/GitOperations.js';
import { structuredPlanOutput } from '../helpers/structured-plan.js';
import { verifyAgentOutput } from '../helpers/verify-result.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runWorkflow } from '../../src/orchestrator/steps/RunWorkflowStep.js';
import { IssueTracker } from '../../src/tracker/IssueTracker.js';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import { buildPlanModePipeline } from '../../src/pipeline/PipelineMetadata.js';
import { resetKnowledgeCache } from '../../src/knowledge/KnowledgeLoader.js';
import { createMockOrchestratorDeps, createTestConfig, createTestIssue } from '../helpers/mock-factories.js';
import type { AIRunner, RunOptions } from '../../src/ai-runner/AIRunner.js';
import type { IssueProcessingContext } from '../../src/orchestrator/IssueProcessingContext.js';
import { UatResultStore } from '../../src/e2e/UatResultStore.js';
import type { UatResult } from '../../src/shared/workbench.js';
import { randomUUID } from 'node:crypto';

const uatBehavior = vi.hoisted(() => ({ fail: false }));

// 计划、构建、验证、状态机和落盘都使用实际实现；本组只隔离浏览器阶段和外部平台。
vi.mock('../../src/phases/PhaseFactory.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/phases/PhaseFactory.js')>();
  return {
    ...original,
    createPhase: (...args: Parameters<typeof original.createPhase>) => args[0] === 'uat'
      ? { run: async () => {
          if (uatBehavior.fail) return { kind: 'requestRetryFrom', targetPhaseId: 'build', reason: 'uat-assertion-failed', context: { rawReport: '浏览器断言失败，需要修复' } };
          const tracker = args[5]!;
          const run = tracker.get(1)!.run!;
          const now = new Date().toISOString();
          const summary: UatResult = {
            format: 'iaf-mini/uat/v1', status: 'completed', runId: randomUUID(), issueIid: 1,
            machinePassed: true, passed: true, passedTests: 1, failedTests: 0, skippedTests: 0,
            evidence: [], reportAvailable: false, startedAt: now, machineFinishedAt: now, finishedAt: now,
            visualReview: { status: 'not-run', summary: '视觉复核未启用', issues: [], selectedScreenshots: [], checkedScreenshots: [], unreviewedScreenshots: [], coverageGaps: [], reasonCode: 'disabled' },
            policy: { visualReviewEnabled: false, maxImages: 12, timeoutMs: 180000 },
            execution: { candidateCommit: run.candidateCommit!, planRevision: run.planRevision, planDigest: run.planDigest!, buildGeneration: run.buildGeneration, dispatchId: run.dispatchId!, phaseAttemptNo: run.phaseExecutions.uat ?? 1 },
          };
          summary.summaryDigest = UatResultStore.digest(summary);
          const store = new UatResultStore(args[3].dataDirectory);
          store.writeSummary(summary);
          tracker.transaction(1, (record) => {
            record.run!.uatExecution = {
              runId: summary.runId, status: summary.status, startedAt: now,
              execution: summary.execution, policy: summary.policy,
            };
          });
          // 故意不生成展示副本：阶段必须从聚合状态读取本轮运行。
          return { kind: 'completed', output: '模拟验收通过' };
        }, getResultFiles: () => [] }
      : original.createPhase(...args),
  };
});

let dir: string;
const disposableRepositories: string[] = [];
beforeEach(() => {
  uatBehavior.fail = false;
  const root = path.resolve('.iaf-mini/repair-tests');
  fs.mkdirSync(root, { recursive: true });
  dir = fs.mkdtempSync(path.join(root, '流程配置 '));
  vi.stubEnv('DATA_DIR', dir);
  resetKnowledgeCache();
});
afterEach(() => {
  for (const directory of disposableRepositories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetKnowledgeCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(options: { e2e?: boolean; review?: boolean; label?: boolean; max?: number; loop?: boolean; failVerify?: boolean } = {}) {
  const repository = graphFixture();
  const config = createTestConfig();
  Object.assign(config.project, { gitRootDir: repository.repo, workDir: repository.integration, worktreeBaseDir: repository.worktrees, projectSubDir: '' });
  if (options.e2e !== false) {
  fs.writeFileSync(path.join(repository.integration, 'playwright.config.ts'), 'export default {};');
  realGit(repository.integration, 'add', '.'); realGit(repository.integration, 'commit', '-m', '验收配置');
  }
  config.review.enabled = options.review ?? false;
  config.preview.enabled = false;
  config.e2e.enabled = options.e2e ?? true;
  vi.mocked(runVerificationCommands).mockImplementation(async opts => verificationChecks({ commands: opts.commands, test: options.failVerify ? 'failed' : 'passed' }));
  config.verifyFixLoop.enabled = options.loop ?? true;
  config.verifyFixLoop.maxIterations = options.max ?? 3;
  const pipelineDef = buildPlanModePipeline({ e2eEnabled: config.e2e.enabled });
  const managers = pipelineDef;
  const tracker = new IssueTracker(dir, managers);
  const demand = {
    demandId: 'gh-1', sourceRef: { source: 'github-issue' as const, externalId: '1', displayId: '1' },
    title: '流程配置验证', description: '验证配置驱动的真实阶段循环', createdAt: new Date().toISOString(),
  };
  const record = tracker.create({ lifecycle: { kind: 'pending' }, pipelineMode: 'plan-mode', demandSpec: demand, branchName: 'feat/issue-1' });
  tracker.initPhaseProgress(1, pipelineDef);
  tracker.transaction(1, record => { record.run!.dispatchId = 'configuration-drive'; });
  const plan = new PlanPersistence(repository.integration, 1, dir, tracker);
  const calls: RunOptions[] = [];
  const runner: AIRunner = {
    killAll() {}, killByWorkDir() { return 0; },
    async run(opts) {
      calls.push(opts);
      if (opts.phaseName === 'build') fs.writeFileSync(path.join(opts.workDir, 'result.txt'), String(calls.length));
      return {
        success: true,
        exitCode: 0,
        output: opts.phaseName === 'verify'
          ? verifyAgentOutput({ test: options.failVerify ? 'failed' : 'passed' })
          : structuredPlanOutput('目标是验证审核和自动修复配置真正进入阶段执行逻辑。'),
      };
    },
  };
  const git = new GitOperations(repository.integration);
  const deps = createMockOrchestratorDeps({ mainGitMutex: new AsyncMutex(), config, tracker, aiRunner: runner, shouldAutoApprove: () => options.label ?? false });
  const ctx = {
    issue: createTestIssue({ number: 1 }), branchName: record.branchName,
    wtCtx: { workDir: repository.integration, gitRootDir: repository.integration, issueIid: 1 }, record, isRetry: false, pipelineDef, demand,
    phaseCtx: { demand, workDir: repository.integration, branchName: record.branchName, pipelineMode: 'plan-mode' },
  } as IssueProcessingContext;
  disposableRepositories.push(repository.directory);
  return { config, deps, ctx, calls, plan, managers, drive: () => runWorkflow(ctx, deps, git as never, plan) };
}

describe('配置进入实际阶段循环', { timeout: 300_000 }, () => {
  it('预览重新启动失败时不接受 UAT 或进入交付', async () => {
    const f = fixture();
    f.config.preview.enabled = true;
    f.deps.startPreviewServers = vi.fn().mockResolvedValue(null);
    expect(await f.drive()).toMatchObject({ paused: true });
    expect(f.deps.tracker.get(1)!.run!.uat).toBeUndefined();
    expect(f.deps.tracker.get(1)!.lifecycle.kind).toBe('failed');
  });

  it('等待旧预览退出期间被中止，不再启动替代进程或执行 UAT', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.config.preview.enabled = true;
    f.deps.signal = controller.signal;
    f.deps.stopPreviewServers = vi.fn(async () => { controller.abort(); });
    await expect(f.drive()).rejects.toThrow();
    expect(f.deps.startPreviewServers).not.toHaveBeenCalled();
    expect(f.deps.tracker.get(1)!.run!.uat).toBeUndefined();
  });


  it.each([
    { review: false, label: true, source: 'configuration' },
    { review: true, label: true, source: 'label' },
  ])('新计划保存后按 $source 通过，并持久化审核来源', async options => {
    const f = fixture(options);
    expect(await f.drive()).toMatchObject({ paused: false });
    expect(f.plan.isArtifactReady('01-plan.md')).toBe(true);
    const restored = new IssueTracker(dir, f.managers).get(1)!;
    expect(restored.lifecycle.kind).toBe('completed');
    expect(restored.phaseHistory).toContainEqual(expect.objectContaining({ phaseId: 'review', outcome: 'gate-approved', approvalSource: options.source }));
    expect(f.calls.map(c => c.phaseName)).toEqual(['plan', 'build', 'verify']);
  });

  it('关闭审核后重启不会自动批准已在等待的计划', async () => {
    const f = fixture({ review: true });
    expect(await f.drive()).toMatchObject({ paused: true });
    expect(f.deps.tracker.get(1)?.lifecycle).toMatchObject({ kind: 'waiting', phase: 'review' });
    f.config.review.enabled = false;
    f.deps.tracker = new IssueTracker(dir, f.managers);
    await f.drive();
    expect(f.calls.map(c => c.phaseName)).toEqual(['plan']);
    expect(f.deps.tracker.get(1)?.lifecycle).toMatchObject({ kind: 'waiting', phase: 'review' });
  });

  it('完整计划保存失败时不能进入构建', async () => {
    const f = fixture();
    vi.spyOn(f.plan, 'writePlan').mockImplementationOnce(() => { throw new Error('计划落盘失败'); });
    vi.spyOn(f.deps.tracker.store, 'savePlan').mockImplementation(() => { throw new Error('计划落盘失败'); });
    expect(await f.drive()).toMatchObject({ paused: true });
    expect(f.calls.every(c => c.phaseName === 'plan')).toBe(true);
    expect(f.deps.tracker.get(1)?.phaseHistory?.some(h => h.outcome === 'gate-approved')).toBe(false);
  });

  it.each([1, 3])('最多追加 %i 轮修复，超限后停在验证失败', async max => {
    const f = fixture({ max, failVerify: true });
    expect(await f.drive()).toMatchObject({ paused: true });
    expect(f.calls.filter(c => c.phaseName === 'build')).toHaveLength(max + 1);
    expect(f.calls.filter(c => c.phaseName === 'verify')).toHaveLength(max + 1);
    const record = f.deps.tracker.get(1)!;
    expect(record.lifecycle).toMatchObject({ kind: 'failed', phase: 'verify', retry: 'manual' });
    expect(record.phaseHistory?.filter(h => h.outcome === 'retried-from')).toHaveLength(max);
    expect(record.phaseHistory?.some(h => h.phaseId === 'uat')).toBe(false);
  });

  it('关闭自动修复后不追加构建，也不进入验收或交付', async () => {
    const f = fixture({ loop: false, failVerify: true });
    expect(await f.drive()).toMatchObject({ paused: true });
    expect(f.calls.map(c => c.phaseName)).toEqual(['plan', 'build', 'verify']);
    expect(f.deps.tracker.get(1)?.lifecycle).toMatchObject({ kind: 'failed', phase: 'verify', retry: 'manual' });
    expect(f.deps.tracker.get(1)?.phaseHistory?.some(h => h.phaseId === 'uat')).toBe(false);
  });

  it('服务重启后从落盘历史继续计算修复次数', async () => {
    const f = fixture({ max: 3, failVerify: true });
    const controller = new AbortController();
    f.deps.signal = controller.signal;
    const transaction = f.deps.tracker.transaction.bind(f.deps.tracker);
    vi.spyOn(f.deps.tracker, 'transaction').mockImplementation((number, update) => {
      const record = transaction(number, update);
      if (record.run!.repairRounds === 1) controller.abort();
      return record;
    });
    await expect(f.drive()).rejects.toThrow();
    expect(f.calls.filter(c => c.phaseName === 'verify')).toHaveLength(1);
    f.deps.signal = undefined;
    f.deps.tracker = new IssueTracker(dir, f.managers);
    expect(await f.drive()).toMatchObject({ paused: true });
    expect(f.calls.filter(c => c.phaseName === 'build')).toHaveLength(4);
    expect(f.calls.filter(c => c.phaseName === 'verify')).toHaveLength(4);
    expect(f.deps.tracker.get(1)?.phaseHistory?.filter(h => h.outcome === 'retried-from')).toHaveLength(3);
  });
});

it('有效 UAT 断言失败实际进入集成修复且受共享轮次上限约束', async () => {
  uatBehavior.fail = true;
  const f = fixture({ max: 1 });
  await f.drive();
  const state = f.deps.tracker.get(1)!;
  expect(state.run!.repairRounds).toBe(1);
  expect(f.calls.filter(call => call.prompt.includes('按已批准的计划修复集成代码'))).toHaveLength(1);
  expect(f.calls.filter(call => call.phaseName === 'verify')).toHaveLength(2);
  expect(Object.values(state.run!.tasks).every(task => task.status === 'merged')).toBe(true);
  expect(state.lifecycle.kind).toBe('failed');
}, 300_000);

it('关闭 E2E 后无需 Playwright 配置，仍完成真实计划、任务图和 verify', async () => {
  const f = fixture({ e2e: false });
  expect(await f.drive()).toMatchObject({ paused: false });
  const record = f.deps.tracker.get(1)!;
  expect(Object.hasOwn(record.phaseProgress!, 'uat')).toBe(false);
  expect(record.run!.verify?.passed).toBe(true);
  expect(record.run!.uat).toBeUndefined();
  expect(record.phaseHistory?.some(entry => entry.phaseId === 'uat')).toBe(false);
  expect(f.calls.map(call => call.phaseName)).toEqual(['plan', 'build', 'verify']);
  expect(fs.existsSync(path.join(f.ctx.wtCtx.workDir, 'playwright.config.ts'))).toBe(false);
});

it('关闭 E2E 后 verify 失败仍阻止交付', async () => {
  const f = fixture({ e2e: false, failVerify: true, loop: false });
  expect(await f.drive()).toMatchObject({ paused: true });
  expect(f.deps.tracker.get(1)?.lifecycle.kind).toBe('failed');
  expect(f.deps.tracker.get(1)?.run?.verify).toBeUndefined();
});
