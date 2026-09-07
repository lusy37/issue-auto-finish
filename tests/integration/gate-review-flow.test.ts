// 本组验证核心调度；真实 Git、UAT 及交付门禁由 mini-workflow 集成测试覆盖。
vi.mock('../../src/orchestrator/steps/CompletionStep.js', () => ({ executeCompletion: async (ctx: any, deps: any) => { const pr=await deps.github.createPullRequest({sourceBranch:ctx.branchName,targetBranch:deps.config.project.baseBranch,title:ctx.issue.title}); await deps.github.updateIssueLabels(ctx.issue.id, ['auto-finish:done']); deps.tracker.updateState(ctx.issue.number, 'completed', {prUrl:pr.html_url,deliveryPending:false,completedAt:new Date().toISOString()}); } }));
/**
 * 集成测试：Gate 审核流程 (plan-mode)
 *
 * 验证：plan-mode 流水线中 review gate 的暂停、批准、驳回行为。
 * 使用真实 IssueTracker 跟踪状态流转。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IssueState } from '../../src/tracker/IssueState.js';
import {
  createHarness,
  createIntegrationTestIssue,
  type IntegrationHarness,
} from '../helpers/integration-harness.js';

// ── Module mocks ──

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
  writeProgress: vi.fn(),
  readProgress: vi.fn().mockReturnValue(null),
  getAllPlanFiles: vi.fn().mockReturnValue([]),
  createInitialProgress: vi.fn().mockReturnValue({
    displayId: 42,
    title: 'Test',
    branchName: 'feat/issue-42',
    currentPhase: 'plan',
    phases: {
      plan: { status: 'pending' },
      review: { status: 'pending' },
      build: { status: 'pending' },
      verify: { status: 'pending' },
    },
  }),
  updatePhaseProgress: vi.fn(),
  updatePhaseSessionId: vi.fn(),
  writeReviewFeedback: vi.fn(),
  readReviewFeedback: vi.fn().mockReturnValue(null),
  mergeBackupIfPresent: vi.fn(),
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

const { PipelineOrchestrator } = await import('../../src/orchestrator/PipelineOrchestrator.js');

describe('集成测试：Gate 审核流程', () => {
  let harness: IntegrationHarness;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    harness?.cleanup();
  });

  it('processIssue 在 review gate 暂停 → 批准后恢复到完成', async () => {
    harness = createHarness();

    const issue = createIntegrationTestIssue();

    const orchestrator = new PipelineOrchestrator(
      harness.config,
      harness.github as any,
      harness.git as any,
      harness.aiRunner as any,
      harness.tracker,
    );

    // 第一次调用：执行 plan 后在 review gate 暂停
    await orchestrator.processIssue(issue);

    const recordPaused = harness.tracker.get(issue.number);
    expect(recordPaused!.state).toBe(IssueState.PhaseWaiting);
    expect(recordPaused!.currentPhase).toBe('review');
    expect(mockPhaseRun).toHaveBeenCalledTimes(1);

    // 模拟用户批准
    harness.tracker.updateState(issue.number, IssueState.PhaseApproved, { currentPhase: 'review' });

    const recordApproved = harness.tracker.get(issue.number);
    expect(recordApproved!.state).toBe(IssueState.PhaseApproved);

    // 第二次调用：从 PhaseApproved 恢复，执行 build + verify
    vi.clearAllMocks();
    await orchestrator.processIssue(issue);

    const finalRecord = harness.tracker.get(issue.number);
    expect(finalRecord!.state).toBe(IssueState.Completed);
    // 恢复后应执行 build + verify = 2 个阶段
    expect(mockPhaseRun).toHaveBeenCalledTimes(2);
  });

  it('驳回后从头重新规划', async () => {
    harness = createHarness();

    const issue = createIntegrationTestIssue();

    const orchestrator = new PipelineOrchestrator(
      harness.config,
      harness.github as any,
      harness.git as any,
      harness.aiRunner as any,
      harness.tracker,
    );

    // 第一次调用：执行 plan 后在 review gate 暂停
    await orchestrator.processIssue(issue);

    const recordPaused = harness.tracker.get(issue.number);
    expect(recordPaused!.state).toBe(IssueState.PhaseWaiting);

    // 模拟用户驳回：将状态重置到 BranchCreated（模拟 CommandExecutor.handleReject）
    harness.tracker.updateState(issue.number, IssueState.BranchCreated);

    const recordRejected = harness.tracker.get(issue.number);
    expect(recordRejected!.state).toBe(IssueState.BranchCreated);

    // 第二次调用：从 BranchCreated 重新开始（plan → review gate 再次暂停）
    vi.clearAllMocks();
    await orchestrator.processIssue(issue);

    const recordSecondPause = harness.tracker.get(issue.number);
    expect(recordSecondPause!.state).toBe(IssueState.PhaseWaiting);
    expect(recordSecondPause!.currentPhase).toBe('review');
    // 重新执行了 plan
    expect(mockPhaseRun).toHaveBeenCalledTimes(1);
  });

  it('auto-approve 标签跳过 review gate', async () => {
    harness = createHarness({
      review: { enabled: true, autoApproveLabels: ['fast-track'] },
    });

    const issue = createIntegrationTestIssue({
      labels: ['auto-finish', 'fast-track'],
    });

    const orchestrator = new PipelineOrchestrator(
      harness.config,
      harness.github as any,
      harness.git as any,
      harness.aiRunner as any,
      harness.tracker,
    );

    await orchestrator.processIssue(issue);

    const record = harness.tracker.get(issue.number);
    // 应该直接完成，不暂停
    expect(record!.state).toBe(IssueState.Completed);
    // plan + build + verify = 3
    expect(mockPhaseRun).toHaveBeenCalledTimes(3);
  });

  it('auto-approve 标签不匹配时仍暂停', async () => {
    harness = createHarness({
      review: { enabled: true, autoApproveLabels: ['fast-track'] },
    });

    const issue = createIntegrationTestIssue({
      labels: ['auto-finish'], // 不含 fast-track
    });

    const orchestrator = new PipelineOrchestrator(
      harness.config,
      harness.github as any,
      harness.git as any,
      harness.aiRunner as any,
      harness.tracker,
    );

    await orchestrator.processIssue(issue);

    const record = harness.tracker.get(issue.number);
    expect(record!.state).toBe(IssueState.PhaseWaiting);
    expect(record!.currentPhase).toBe('review');
    expect(mockPhaseRun).toHaveBeenCalledTimes(1);
  });
});
