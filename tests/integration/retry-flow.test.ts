// 本组验证核心调度；真实 Git、UAT 及交付门禁由 mini-workflow 集成测试覆盖。
vi.mock('../../src/orchestrator/steps/CompletionStep.js', () => ({ executeCompletion: async (ctx: any, deps: any) => { const pr=await deps.github.createPullRequest({sourceBranch:ctx.branchName,targetBranch:deps.config.project.baseBranch,title:ctx.issue.title}); await deps.github.updateIssueLabels(ctx.issue.id, ['auto-finish:done']); deps.tracker.updateState(ctx.issue.number, 'completed', {prUrl:pr.html_url,deliveryPending:false,completedAt:new Date().toISOString()}); } }));
/**
 * 集成测试：失败重试流程
 *
 * 验证：AI Runner 首次失败 → tracker 记录失败状态 → 重试恢复 → 最终完成。
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

const mockPhaseRun = vi.fn();

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

describe('集成测试：失败重试流程', () => {
  let harness: IntegrationHarness;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPhaseRun.mockResolvedValue({ kind: 'completed', output: 'ok' });
  });

  afterEach(() => {
    harness?.cleanup();
  });

  it('首次执行 AI 阶段失败 → 状态变为 Failed', async () => {
    harness = createHarness();

    const issue = createIntegrationTestIssue();

    // plan 阶段失败
    mockPhaseRun.mockRejectedValueOnce(new Error('AI runner crashed'));

    const orchestrator = new PipelineOrchestrator(
      harness.config,
      harness.github as any,
      harness.git as any,
      harness.aiRunner as any,
      harness.tracker,
    );

    await expect(orchestrator.processIssue(issue)).rejects.toThrow('AI runner crashed');

    // 验证 tracker 记录了失败状态
    const record = harness.tracker.get(issue.number);
    expect(record).toBeDefined();
    expect(record!.state).toBe(IssueState.Failed);
    expect(record!.lastError).toContain('AI runner crashed');
    expect(record!.failedAtState).toBeDefined();
    expect(record!.attempts).toBe(1);
  });

  it('失败后重试 → 成功完成', async () => {
    harness = createHarness({
      review: { enabled: true, autoApproveLabels: ['skip-review'] },
    });

    const issue = createIntegrationTestIssue({
      labels: ['auto-finish', 'skip-review'],
    });

    // 第一次执行：plan 阶段失败
    mockPhaseRun.mockRejectedValueOnce(new Error('Temporary failure'));

    const orchestrator = new PipelineOrchestrator(
      harness.config,
      harness.github as any,
      harness.git as any,
      harness.aiRunner as any,
      harness.tracker,
    );

    // 首次执行 → 失败
    await expect(orchestrator.processIssue(issue)).rejects.toThrow('Temporary failure');

    const recordAfterFail = harness.tracker.get(issue.number);
    expect(recordAfterFail!.state).toBe(IssueState.Failed);
    expect(recordAfterFail!.attempts).toBe(1);

    // 重置以重试（模拟 IssuePoller 的 resetForRetry）
    harness.tracker.resetForRetry(issue.number);

    const recordAfterReset = harness.tracker.get(issue.number);
    expect(recordAfterReset!.state).not.toBe(IssueState.Failed);
    expect(recordAfterReset!.lastError).toBeUndefined();

    // 重试执行 → 成功（mockPhaseRun 已回到默认 resolved）
    await orchestrator.processIssue(issue);

    const finalRecord = harness.tracker.get(issue.number);
    expect(finalRecord!.state).toBe(IssueState.Completed);
  });

  it('canRetry 在超过 maxRetries 后返回 false', async () => {
    harness = createHarness({
      poll: { maxRetries: 2, discoveryIntervalMs: 60000, driveIntervalMs: 15000, maxConcurrent: 3 },
    });

    const issue = createIntegrationTestIssue();

    const orchestrator = new PipelineOrchestrator(
      harness.config,
      harness.github as any,
      harness.git as any,
      harness.aiRunner as any,
      harness.tracker,
    );

    // 连续失败多次
    for (let attempt = 0; attempt < 3; attempt++) {
      mockPhaseRun.mockRejectedValueOnce(new Error(`Failure #${attempt + 1}`));

      // 如果不是第一次，需要重置
      if (attempt > 0) {
        const record = harness.tracker.get(issue.number);
        if (record?.state === IssueState.Failed) {
          harness.tracker.resetForRetry(issue.number);
        }
      }

      await expect(orchestrator.processIssue(issue)).rejects.toThrow();
    }

    // 3 次失败后，canRetry(maxRetries=2) 应返回 false
    const canRetry = harness.tracker.canRetry(issue.number, 2);
    expect(canRetry).toBe(false);

    // 仍然可以用 maxRetries=5 重试
    const canRetryHighLimit = harness.tracker.canRetry(issue.number, 5);
    expect(canRetryHighLimit).toBe(true);
  });

  it('resetFull 完全重置，从头开始', async () => {
    harness = createHarness();

    const issue = createIntegrationTestIssue();

    // 首次执行：plan 阶段失败
    mockPhaseRun.mockRejectedValueOnce(new Error('crash'));

    const orchestrator = new PipelineOrchestrator(
      harness.config,
      harness.github as any,
      harness.git as any,
      harness.aiRunner as any,
      harness.tracker,
    );

    await expect(orchestrator.processIssue(issue)).rejects.toThrow('crash');

    const recordAfterFail = harness.tracker.get(issue.number);
    expect(recordAfterFail!.state).toBe(IssueState.Failed);
    expect(recordAfterFail!.attempts).toBe(1);

    // 完全重置
    harness.tracker.resetFull(issue.number);

    const recordAfterReset = harness.tracker.get(issue.number);
    expect(recordAfterReset!.state).toBe(IssueState.Pending);
    expect(recordAfterReset!.attempts).toBe(0);
    expect(recordAfterReset!.failedAtState).toBeUndefined();
    expect(recordAfterReset!.lastError).toBeUndefined();
    expect(recordAfterReset!.sessionId).toBeUndefined();
  });
});
