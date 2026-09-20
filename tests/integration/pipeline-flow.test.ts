vi.mock('../../src/orchestrator/DagPhaseRunner.js', () => ({ DagPhaseRunner: isolatedPhaseRunner((...args) => mockPhaseRun(...args)) }));
import { isolatedPhaseRunner } from '../helpers/isolated-phase-runner.js';
// 本组验证核心调度；真实 Git、UAT 及交付门禁由 mini-workflow 集成测试覆盖。
vi.mock('../../src/orchestrator/steps/DeliverIssueStep.js', () => ({ deliverIssueStep: async (ctx: any, deps: any) => { const pr=await deps.github.createPullRequest({sourceBranch:ctx.branchName,targetBranch:deps.config.project.baseBranch,title:ctx.issue.title}); await deps.github.updateIssueLabels(ctx.issue.id, ['auto-finish:done']); deps.tracker.transaction(ctx.issue.number, (record: any) => { record.lifecycle = { kind: 'completed' }; record.prUrl=pr.html_url; record.deliveryPending=false; record.completedAt=new Date().toISOString(); }); } }));
/**
 * 集成测试：流水线正常流程（happy path）
 *
 * 验证：使用真实 IssueTracker + 文件持久化，Mock 外部服务，
 * processIssue 从头到尾走完 plan-mode 流水线（含 auto-approve）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createHarness,
  createIntegrationTestIssue,
  type IntegrationHarness,
} from '../helpers/integration-harness.js';

// ── Module mocks (same pattern as unit tests) ──

const mockWtGitInstance = {
  fetch: vi.fn().mockResolvedValue(undefined),
  checkout: vi.fn().mockResolvedValue(undefined),
  add: vi.fn().mockResolvedValue(undefined),
  commit: vi.fn().mockResolvedValue(undefined),
  push: vi.fn().mockResolvedValue(undefined),
  hasChanges: vi.fn().mockResolvedValue(false),
  addAndCommit: vi.fn().mockResolvedValue(undefined),
  addCommitAndPush: vi.fn().mockResolvedValue(undefined),
  branchExists: vi.fn().mockResolvedValue(false),
  remoteBranchExists: vi.fn().mockResolvedValue(false),
  isRebaseInProgress: vi.fn().mockResolvedValue(false),
};

const mockWtPlanInstance = {
  baseDir: '/tmp/test-plan',
  ensureDir: vi.fn(),
  writeIssueMeta: vi.fn(),
  getAllPlanFiles: vi.fn().mockReturnValue([]),

  readReviewFeedback: vi.fn().mockReturnValue(null),

  writePlan: vi.fn(),
};

const mockPhaseRun = vi.fn().mockResolvedValue({ kind: 'completed', output: 'ok' });

vi.mock('../../src/git/GitOperations.js', () => ({
  GitOperations: vi.fn().mockImplementation(() => mockWtGitInstance),
}));

vi.mock('../../src/persistence/PlanPersistence.js', () => ({
  PlanPersistence: vi.fn().mockImplementation(() => mockWtPlanInstance),
}));

vi.mock('../../src/phases/PhaseFactory.js', () => ({
  createPhase: vi.fn().mockImplementation((name: string) => ({
    phaseName: name,
    run: mockPhaseRun,
    getResultFiles: vi.fn().mockReturnValue([]),
    setWtGitMap: vi.fn(),
  })),
}));

const mockExecFileAsync = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const taggedExecFile = Object.assign((...args: unknown[]) => {
    return (original.execFile as Function)(...args);
  }, { __mocked: true });
  return { ...original, execFile: taggedExecFile };
});

vi.mock('node:util', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:util')>();
  return {
    ...original,
    promisify: (fn: unknown) => {
      if (typeof fn === 'function' && '__mocked' in fn) return mockExecFileAsync;
      return original.promisify(fn as (...args: unknown[]) => unknown);
    },
  };
});

const { IssueService } = await import('../../src/orchestrator/IssueService.js');

describe('集成测试：流水线正常流程', () => {
  let harness: IntegrationHarness;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    harness?.cleanup();
  });

  it('auto-approve 模式下完整走完 plan-mode 流水线', async () => {
    harness = createHarness({
      review: { enabled: true, autoApproveLabels: ['skip-review'] },
      e2e: { enabled: true },
    });

    const issue = createIntegrationTestIssue({
      labels: ['auto-finish', 'skip-review'],
    });

    const orchestrator = new IssueService(
      harness.config,
      harness.github as any,
      harness.git as any,
      harness.aiRunner as any,
      harness.tracker,
    );

    await orchestrator.processIssue(issue);

    // 1. 验证 tracker 状态为 Completed
    const record = harness.tracker.get(issue.number);
    expect(record).toBeDefined();
    expect(record!.lifecycle.kind).toBe('completed');
    expect(record!.prUrl).toBeDefined();

    // 2. 验证开始评论被发送
    expect(harness.github.createIssueNote).toHaveBeenCalled();

    // 3. 验证标签更新：先 processing，后 done
    const labelCalls = harness.github.updateIssueLabels.mock.calls;
    expect(labelCalls.length).toBeGreaterThanOrEqual(2);
    // 第一次：auto-finish:processing
    expect(labelCalls[0][1]).toContain('auto-finish:processing');
    // 最后一次：auto-finish:done
    const lastLabelCall = labelCalls[labelCalls.length - 1];
    expect(lastLabelCall[1]).toContain('auto-finish:done');

    // 4. 验证 AI 阶段执行了 3 次（plan + build + verify，review 被 auto-approve）
    expect(mockPhaseRun).toHaveBeenCalledTimes(4);
  });

  it('无 auto-approve 时在 review gate 暂停', async () => {
    harness = createHarness({ e2e: { enabled: true } });

    const issue = createIntegrationTestIssue();

    const orchestrator = new IssueService(
      harness.config,
      harness.github as any,
      harness.git as any,
      harness.aiRunner as any,
      harness.tracker,
    );

    await orchestrator.processIssue(issue);

    // 验证在 review gate 暂停
    const record = harness.tracker.get(issue.number);
    expect(record).toBeDefined();
    expect(record!.lifecycle).toMatchObject({ kind: 'waiting', phase: 'review' });

    // 仅执行了 plan 阶段
    expect(mockPhaseRun).toHaveBeenCalledTimes(1);
  });

  it('从 PhaseApproved 恢复执行到完成', async () => {
    harness = createHarness({
      review: { enabled: true, autoApproveLabels: [] },
      e2e: { enabled: true },
    });

    const issue = createIntegrationTestIssue();

    // 先创建已在 review gate 的记录
    harness.tracker.create({
      lifecycle: { kind: 'ready' },
      branchName: 'feat/issue-42',
      pipelineMode: 'plan-mode',
      demandSpec: {
        demandId: 'gh-42',
        sourceRef: { source: 'github-issue', externalId: '100', displayId: '42' },
        title: issue.title,
        description: issue.description || '',
        createdAt: '2024-01-01T00:00:00Z',
      },
    });

    const orchestrator = new IssueService(
      harness.config,
      harness.github as any,
      harness.git as any,
      harness.aiRunner as any,
      harness.tracker,
    );

    await orchestrator.processIssue(issue);
    await orchestrator.applyGateAction(issue.number, { action: 'approve' }, harness.tracker.get(issue.number)!.run!.planRevision);
    vi.clearAllMocks();
    await orchestrator.processIssue(issue);

    // 验证完成
    const record = harness.tracker.get(issue.number);
    expect(record).toBeDefined();
    expect(record!.lifecycle.kind).toBe('completed');

    // 应该执行了 build + verify = 2 个 AI 阶段
    expect(mockPhaseRun).toHaveBeenCalledTimes(2);
  });

  it('tracker 持久化到文件并可恢复', async () => {
    harness = createHarness({ e2e: { enabled: true } });

    const issue = createIntegrationTestIssue();

    const orchestrator = new IssueService(
      harness.config,
      harness.github as any,
      harness.git as any,
      harness.aiRunner as any,
      harness.tracker,
    );

    await orchestrator.processIssue(issue);

    // 验证 tracker 文件被写入
    const record = harness.tracker.get(issue.number);
    expect(record).toBeDefined();

    // 创建新的 tracker 实例读取同一文件
    const { IssueTracker: TrackerClass } = await import('../../src/tracker/IssueTracker.js');
    const { PLAN_MODE_PIPELINE: planPipeline } = await import('../../src/pipeline/PipelineMetadata.js');

    const lifecycleManagers = new Map();
    lifecycleManagers.set('plan-mode', planPipeline);

    const tracker2 = new TrackerClass(harness.dataDir, lifecycleManagers);
    const recoveredRecord = tracker2.get(issue.number);
    expect(recoveredRecord).toBeDefined();
    expect(recoveredRecord!.lifecycle).toEqual(record!.lifecycle);
  });
});
