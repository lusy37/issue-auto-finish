import { suspendAtReview } from '../helpers/native-review.js';
import { structuredPlanOutput } from '../helpers/structured-plan.js';
import { newIssueRun } from '../../src/dag/contracts.js';
vi.mock('../../src/orchestrator/DagPhaseRunner.js', () => ({ DagPhaseRunner: isolatedPhaseRunner((...args) => mockPhaseRun(...args)) }));
import { isolatedPhaseRunner } from '../helpers/isolated-phase-runner.js';
// 本组验证核心调度；真实 Git、UAT 及交付门禁由 mini-workflow 集成测试覆盖。
vi.mock('../../src/orchestrator/steps/DeliverIssueStep.js', () => ({ deliverIssueStep: async (ctx: any, deps: any) => { const pr=await deps.github.createPullRequest({sourceBranch:ctx.branchName,targetBranch:deps.config.project.baseBranch,title:ctx.issue.title}); await deps.github.updateIssueLabels(ctx.issue.id, ['auto-finish:done']); deps.tracker.updateState(ctx.issue.number, 'completed', {prUrl:pr.html_url,deliveryPending:false,completedAt:new Date().toISOString()}); } }));
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IssueState } from '../../src/tracker/IssueState.js';
import { eventBus, type EventPayload } from '../../src/events/EventBus.js';
import { GateActionError } from '../../src/orchestration/index.js';
import {
  createMockGitOperations,
  createMockGitHubClient,
  createMockAIRunner,
  createMockIssueTracker,
  createTestConfig,
  createTestIssue,
} from '../helpers/mock-factories.js';

const mockWtGitInstance = createMockGitOperations();
const mockWtPlanInstance = {
  baseDir: path.join('/tmp/test-worktrees', 'issue-42/app/mmpayxdcdevopslogicsvr'),
  ensureDir: vi.fn(),
  writeIssueMeta: vi.fn(),
  writeProgress: vi.fn(),
  readProgress: vi.fn().mockReturnValue(null),
  writePlan: vi.fn(),
  writeReviewFeedback: vi.fn(),
  readReviewFeedback: vi.fn().mockReturnValue(null),
  mergeBackupIfPresent: vi.fn(),
  getAllPlanFiles: vi.fn().mockReturnValue([]),
  createInitialProgress: vi.fn().mockReturnValue({
    displayId: 100,
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
};

const mockPhaseRun = vi.fn().mockResolvedValue({ kind: 'completed', output: 'ok' });

const mockFsAccess = vi.fn().mockResolvedValue(undefined);
const mockFsUnlink = vi.fn().mockRejectedValue(new Error('ENOENT'));
const mockFsRm = vi.fn().mockResolvedValue(undefined);
const mockFsMkdir = vi.fn().mockResolvedValue(undefined);

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    default: {
      ...original.default,
      readdir: async () => [],
      rmdir: async () => {},
      access: (...args: unknown[]) => mockFsAccess(...args),
      unlink: (...args: unknown[]) => mockFsUnlink(...args),
      rm: (...args: unknown[]) => mockFsRm(...args),
      mkdir: (...args: unknown[]) => mockFsMkdir(...args),
    },
  };
});

vi.mock('../../src/git/GitOperations.js', () => ({
  GitOperations: vi.fn().mockImplementation(() => mockWtGitInstance),
}));

vi.mock('../../src/persistence/PlanPersistence.js', () => {
  const ctor = vi.fn().mockImplementation(() => mockWtPlanInstance);
  // 静态方法：reject 路径在 worktree 缺失时降级写入全局后备
  (ctor as unknown as { writeReviewFeedbackBackup: typeof vi.fn }).writeReviewFeedbackBackup = vi.fn();
  (ctor as unknown as { readReviewHistoryBackup: typeof vi.fn }).readReviewHistoryBackup = vi.fn().mockReturnValue([]);
  return { PlanPersistence: ctor };
});

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
  return {
    ...original,
    execFile: taggedExecFile,
  };
});

vi.mock('node:util', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:util')>();
  return {
    ...original,
    promisify: (fn: unknown) => {
      if (typeof fn === 'function' && '__mocked' in fn) {
        return mockExecFileAsync;
      }
      return original.promisify(fn as (...args: unknown[]) => unknown);
    },
  };
});

const { IssueService } = await import('../../src/orchestrator/IssueService.js');

describe('IssueService', () => {
  let config = createTestConfig();
  let mockGitHub = createMockGitHubClient();
  let mockMainGit = createMockGitOperations();
  let mockAiRunner = createMockAIRunner();
  let mockTracker = createMockIssueTracker();

  let trackerStore: Map<number, any>;

  function attachStatefulTracker(seed?: any): void {
    if (seed) { seed.run ??= newIssueRun(); trackerStore.set(seed.issueIid ?? Number(seed.demandSpec?.sourceRef?.displayId ?? 42), seed); }
    mockTracker.create.mockImplementation((record: any) => {
      const r = {
        ...record,
        run: newIssueRun(),
        attempts: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      trackerStore.set(Number(record.demandSpec?.sourceRef?.displayId ?? record.issueIid), r);
      return r;
    });
    mockTracker.updateState.mockImplementation((number: number, state: any, extra?: any) => {
      const cur = trackerStore.get(number) ?? { issueIid: number, attempts: 0 };
      trackerStore.set(number, { ...cur, ...extra, state, updatedAt: new Date().toISOString() });
    });
    mockTracker.markFailed.mockImplementation((number: number, error: any, opts?: any) => {
      const cur = trackerStore.get(number) ?? { issueIid: number, attempts: 0 };
      trackerStore.set(number, {
        ...cur,
        ...opts,
        state: IssueState.Failed,
        lastError: String(error?.message ?? error),
        attempts: (cur.attempts ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      });
    });
    mockTracker.initPhaseProgress.mockImplementation((number: number, def: any) => {
      const cur = trackerStore.get(number);
      if (cur && !cur.phaseProgress) {
        cur.phaseProgress = Object.fromEntries(def.phases.map((phase: { name: string }) => [phase.name, { status: 'pending' }]));
      }
    });
    mockTracker.get.mockImplementation((number: number) => { const record = trackerStore.get(number); if (record) record.run ??= newIssueRun(); return record; });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    config = createTestConfig();
    mockGitHub = createMockGitHubClient();
    mockMainGit = createMockGitOperations();
    mockAiRunner = createMockAIRunner();
    mockTracker = createMockIssueTracker();
    trackerStore = new Map();
    mockFsAccess.mockRejectedValue(new Error('ENOENT'));
    mockFsUnlink.mockRejectedValue(new Error('ENOENT'));
  });

  function createOrchestrator(overrideConfig?: any) {
    return new IssueService(
      overrideConfig || config,
      mockGitHub as any,
      mockMainGit as any,
      mockAiRunner as any,
      mockTracker as any,
    );
  }

  describe('pipeline mode resolution', () => {
    it('defaults to plan-mode for codex-sdk', () => {
      const orch = createOrchestrator();
      expect(orch.getPipelineDef().mode).toBe('plan-mode');
    });

    it('defaults to plan-mode for cursor-agent', () => {
      const cfg = createTestConfig({ ai: { ...config.ai, mode: 'cursor-agent', binary: 'cursor' } });
      const orch = createOrchestrator(cfg);
      expect(orch.getPipelineDef().mode).toBe('plan-mode');
    });

    it('respects explicit pipeline mode override', () => {
      const cfg = createTestConfig({ pipeline: { mode: 'plan-mode' } });
      const orch = createOrchestrator(cfg);
      expect(orch.getPipelineDef().mode).toBe('plan-mode');
    });
  });

  describe('computeWorktreeContext', () => {
    it('computes correct paths from config', () => {
      const orchestrator = createOrchestrator();
      const wtCtx = (orchestrator as any).computeWorktreeContext(42, 'feat/issue-42');

      expect(wtCtx.gitRootDir).toBe(path.join('/tmp/test-worktrees', 'issue-42'));
      expect(wtCtx.workDir).toBe(path.join('/tmp/test-worktrees', 'issue-42/app/mmpayxdcdevopslogicsvr'));
      expect(wtCtx.branchName).toBe('feat/issue-42');
      expect(wtCtx.issueIid).toBe(42);
    });
  });

  describe('ensureWorktree', () => {
    it('reuses existing worktree when path is in worktreeList and .git exists', async () => {
      mockMainGit.worktreeList.mockResolvedValue([path.join('/tmp/test-worktrees', 'issue-42')]);
      mockFsAccess
        .mockResolvedValue(undefined);                // primary .git exists
      const orchestrator = createOrchestrator();
      const wtCtx = (orchestrator as any).computeWorktreeContext(42, 'feat/issue-42');

      await (orchestrator as any).ensureWorktree(wtCtx);

      expect(mockFsAccess).toHaveBeenCalledWith(path.join('/tmp/test-worktrees', 'issue-42/.git'));
      expect(mockMainGit.worktreeAdd).not.toHaveBeenCalled();
    });

    it('recreates worktree when registered but .git is missing', async () => {
      mockMainGit.worktreeList.mockResolvedValue([path.join('/tmp/test-worktrees', 'issue-42')]);
      mockFsAccess.mockRejectedValue(new Error('ENOENT'));
      mockMainGit.branchExists.mockResolvedValue(false);
      mockMainGit.remoteBranchExists.mockResolvedValue(false);
      const orchestrator = createOrchestrator();
      const wtCtx = (orchestrator as any).computeWorktreeContext(42, 'feat/issue-42');

      await (orchestrator as any).ensureWorktree(wtCtx);

      expect(mockMainGit.worktreeRemove).toHaveBeenCalledWith(path.join('/tmp/test-worktrees', 'issue-42'), true);
      expect(mockMainGit.worktreePrune).toHaveBeenCalled();
      expect(mockMainGit.worktreeAdd).toHaveBeenCalled();
    });

    it('calls worktreeAddExisting when local branch exists', async () => {
      mockMainGit.worktreeList.mockResolvedValue([]);
      mockMainGit.branchExists.mockResolvedValue(true);
      const orchestrator = createOrchestrator();
      const wtCtx = (orchestrator as any).computeWorktreeContext(42, 'feat/issue-42');

      await (orchestrator as any).ensureWorktree(wtCtx);

      expect(mockMainGit.worktreeAddExisting).toHaveBeenCalledWith(
        path.join('/tmp/test-worktrees', 'issue-42'),
        'feat/issue-42',
      );
    });

    it('calls worktreeAdd from origin/master when no branch exists', async () => {
      mockMainGit.worktreeList.mockResolvedValue([]);
      mockMainGit.branchExists.mockResolvedValue(false);
      mockMainGit.remoteBranchExists.mockResolvedValue(false);
      const orchestrator = createOrchestrator();
      const wtCtx = (orchestrator as any).computeWorktreeContext(42, 'feat/issue-42');

      await (orchestrator as any).ensureWorktree(wtCtx);

      expect(mockMainGit.worktreeAdd).toHaveBeenCalledWith(
        path.join('/tmp/test-worktrees', 'issue-42'),
        'feat/issue-42',
        'origin/master',
      );
    });
  });

  describe('processIssue (plan-mode pipeline)', () => {
    it('stops at review gate', async () => {
      const issue = createTestIssue();
      attachStatefulTracker();
      mockMainGit.worktreeList.mockResolvedValue([]);
      mockMainGit.branchExists.mockResolvedValue(false);
      mockMainGit.remoteBranchExists.mockResolvedValue(false);

      const orchestrator = createOrchestrator();
      await orchestrator.processIssue(issue);

      expect(mockPhaseRun).toHaveBeenCalledTimes(1);
      const finalRecord = mockTracker.get(issue.number);
      expect(finalRecord?.state).toBe(IssueState.PhaseWaiting);
      expect(finalRecord?.currentPhase).toBe('review');
      expect(finalRecord?.orchestrationState?.kind).toBe('gate-waiting');
    });

    it('preserves worktree on failure', async () => {
      const issue = createTestIssue();
      attachStatefulTracker();
      mockMainGit.worktreeList.mockResolvedValue([]);
      mockMainGit.branchExists.mockResolvedValue(false);
      mockMainGit.remoteBranchExists.mockResolvedValue(false);
      mockPhaseRun.mockResolvedValueOnce({
        kind: 'failed',
        error: { message: 'phase failed', retryable: 'hard-no-auto', rawOutput: 'phase failed' },
      });

      const orchestrator = createOrchestrator();
      await orchestrator.processIssue(issue);

      const finalRecord = mockTracker.get(issue.number);
      expect(finalRecord?.state).toBe(IssueState.Failed);
      expect(mockMainGit.worktreeRemove).not.toHaveBeenCalled();
    });

    it('auto-approves gate when issue has matching autoApproveLabel', async () => {
      const cfg = createTestConfig({
        review: { enabled: true, autoApproveLabels: ['skip-review'] },
        e2e: { enabled: true },
      });
      const issue = createTestIssue({ labels: ['auto-finish', 'skip-review'] });
      attachStatefulTracker();
      mockMainGit.worktreeList.mockResolvedValue([]);
      mockMainGit.branchExists.mockResolvedValue(false);
      mockMainGit.remoteBranchExists.mockResolvedValue(false);

      const orchestrator = createOrchestrator(cfg);
      await orchestrator.processIssue(issue);

      expect(mockPhaseRun).toHaveBeenCalledTimes(4);
      const finalRecord = mockTracker.get(issue.number);
      expect(finalRecord?.state).toBe(IssueState.Completed);
      expect(finalRecord?.prUrl).toEqual(expect.any(String));
    });

    it('still pauses at gate when autoApproveLabels do not match', async () => {
      const cfg = createTestConfig({
        review: { enabled: true, autoApproveLabels: ['skip-review'] },
      });
      const issue = createTestIssue({ labels: ['auto-finish'] });
      attachStatefulTracker();
      mockMainGit.worktreeList.mockResolvedValue([]);
      mockMainGit.branchExists.mockResolvedValue(false);
      mockMainGit.remoteBranchExists.mockResolvedValue(false);

      const orchestrator = createOrchestrator(cfg);
      await orchestrator.processIssue(issue);

      expect(mockPhaseRun).toHaveBeenCalledTimes(1);
      const finalRecord = mockTracker.get(issue.number);
      expect(finalRecord?.state).toBe(IssueState.PhaseWaiting);
      expect(finalRecord?.currentPhase).toBe('review');
    });

    it('resumes after PhaseApproved from build phase', async () => {
      const cfg = createTestConfig({ e2e: { enabled: true } });
      const issue = createTestIssue();
      attachStatefulTracker({
        issueIid: 42,
        branchName: 'feat/issue-42',
        state: IssueState.PhaseApproved,
        currentPhase: 'review',
        orchestrationState: { kind: 'gate-approved', phaseId: 'review' },
        pipelineMode: 'plan-mode',
        attempts: 0,
      });
      mockMainGit.worktreeList.mockResolvedValue([]);
      mockMainGit.branchExists.mockResolvedValue(false);
      mockMainGit.remoteBranchExists.mockResolvedValue(false);

      const orchestrator = createOrchestrator(cfg);
      await orchestrator.processIssue(issue);
      await orchestrator.applyGateAction(issue.number, { action: 'approve' }, mockTracker.get(issue.number)!.run!.planRevision);
      vi.clearAllMocks();
      await orchestrator.processIssue(issue);

      expect(mockPhaseRun).toHaveBeenCalledTimes(3);
      const finalRecord = mockTracker.get(issue.number);
      expect(finalRecord?.state).toBe(IssueState.Completed);
      expect(finalRecord?.prUrl).toEqual(expect.any(String));
    });
  });

  describe('cleanupStaleState', () => {
    it('不会直接删除缺少登记的工作目录', async () => {
      const corruptedDir = '/tmp/test-worktrees/issue-99';
      mockMainGit.worktreeList.mockResolvedValue([config.project.gitRootDir, corruptedDir]);
      // .git file does not exist
      mockFsAccess.mockRejectedValue(new Error('ENOENT'));

      const orchestrator = createOrchestrator();
      await orchestrator.cleanupStaleState();

      expect(mockMainGit.worktreeRemove).not.toHaveBeenCalled();
      expect(mockMainGit.worktreePrune).not.toHaveBeenCalled();
    });

    it('processes healthy worktree normally', async () => {
      const healthyDir = '/tmp/test-worktrees/issue-50';
      mockMainGit.worktreeList.mockResolvedValue([config.project.gitRootDir, healthyDir]);
      // .git file exists
      mockFsAccess.mockResolvedValue(undefined);
      // No rebase in progress
      mockWtGitInstance.isRebaseInProgress.mockResolvedValue(false);
      // No index.lock
      mockFsUnlink.mockRejectedValue(new Error('ENOENT'));

      const orchestrator = createOrchestrator();
      await orchestrator.cleanupStaleState();

      expect(mockMainGit.worktreeRemove).not.toHaveBeenCalled();
    });
  });

  describe('restartIssue', () => {
    it('throws when issue not found', async () => {
      mockTracker.get.mockReturnValue(undefined);
      const orchestrator = createOrchestrator();
      await expect(orchestrator.restartIssue(999)).rejects.toThrow('Issue 999 not found');
    });

    it('完整重做保留分支并重置构建状态', async () => {
      mockTracker.get.mockReturnValue({
        run: newIssueRun(),
        issueIid: 42,
        branchName: 'feat/issue-42',
        state: IssueState.Failed,
      });
      mockTracker.resetFull.mockReturnValue(true);
      const orchestrator = createOrchestrator();
      await orchestrator.restartIssue(42);

      expect(mockMainGit.worktreeRemove).not.toHaveBeenCalled();
      expect(mockMainGit.deleteBranch).not.toHaveBeenCalled();
      expect(mockMainGit.deleteRemoteBranch).not.toHaveBeenCalled();
      expect(mockTracker.resetFull).toHaveBeenCalledWith(42);
    });
  });

  describe('retryFromPhase', () => {
    it('throws when issue not found', () => {
      mockTracker.get.mockReturnValue(undefined);
      const orchestrator = createOrchestrator();
      expect(() => orchestrator.retryFromPhase(999, 'build')).toThrow('Issue 999 not found');
    });

    it('delegates to tracker.resetToPhase with PipelineDef for plan-mode', () => {
      mockTracker.get.mockReturnValue({
        run: newIssueRun(),
        issueIid: 42,
        branchName: 'feat/issue-42',
        state: IssueState.PhaseRunning,
        pipelineMode: 'plan-mode',
      });
      mockTracker.resetToPhase.mockReturnValue(true);
      const orchestrator = createOrchestrator();
      orchestrator.retryFromPhase(42, 'build');
      expect(mockTracker.resetToPhase).toHaveBeenCalledWith(42, 'build', expect.objectContaining({ mode: 'plan-mode' }));
    });

    it('rejects gate phase for retry', () => {
      mockTracker.get.mockReturnValue({
        run: newIssueRun(),
        issueIid: 42,
        branchName: 'feat/issue-42',
        state: IssueState.PhaseRunning,
        pipelineMode: 'plan-mode',
      });
      const orchestrator = createOrchestrator();
      expect(() => orchestrator.retryFromPhase(42, 'review')).toThrow('Invalid phase for retry');
    });
  });

  describe('applyGateAction（LangGraph 原生审核恢复）', () => {
    function captureEvent(name: string): Array<EventPayload<never>> {
      const events: Array<EventPayload<never>> = [];
      const listener = (payload: EventPayload<never>) => events.push(payload);
      eventBus.on(name as never, listener);
      return events;
    }

    it('synchronizes orchestrationState / phaseProgress / phaseHistory and emits unified gate:approved event', async () => {
      attachStatefulTracker({
        issueIid: 42,
        branchName: 'feat/issue-42',
        state: IssueState.PhaseWaiting,
        currentPhase: 'review',
        orchestrationState: { kind: 'gate-waiting', phaseId: 'review', reason: 'human-review' },
        phaseProgress: {
          plan: { status: 'completed' },
          review: { status: 'gate_waiting' },
          build: { status: 'pending' },
          verify: { status: 'pending' },
        },
        pipelineMode: 'plan-mode',
        attempts: 0,
      });
      const gateEvents = captureEvent('gate:approved');

      const orchestrator = createOrchestrator();
      mockTracker.store.savePlan(42, JSON.parse(structuredPlanOutput()));
      await suspendAtReview(mockTracker as any, 42);
      await orchestrator.applyGateAction(42, { action: 'approve' }, 1);

      const record = mockTracker.get(42);
      expect(record?.state).toBe(IssueState.PhaseApproved);
      expect(record?.orchestrationState).toEqual({ kind: 'gate-approved', phaseId: 'review' });

      expect(record?.phaseProgress?.review?.status).toBe('completed');
      expect(record?.phaseHistory).toContainEqual(expect.objectContaining({ phaseId: 'review', outcome: 'gate-approved' }));

      expect(gateEvents).toHaveLength(1);
      expect(gateEvents[0].data).toMatchObject({ issueIid: 42, phaseId: 'review' });
    });

    it('throws GateActionError when issue is not in gate-waiting state', async () => {
      attachStatefulTracker({
        issueIid: 42,
        branchName: 'feat/issue-42',
        state: IssueState.PhaseRunning,
        currentPhase: 'plan',
        orchestrationState: { kind: 'running', phaseId: 'plan' },
        pipelineMode: 'plan-mode',
        attempts: 0,
      });

      const orchestrator = createOrchestrator();
      await expect(
        orchestrator.applyGateAction(42, { action: 'approve' }),
      ).rejects.toBeInstanceOf(GateActionError);
    });

    it('throws GateActionError when reject is attempted on non-review gate', async () => {
      attachStatefulTracker({
        issueIid: 42,
        branchName: 'feat/issue-42',
        state: IssueState.PhaseWaiting,
        currentPhase: 'release',
        orchestrationState: { kind: 'gate-waiting', phaseId: 'release', reason: 'release-confirm' },
        pipelineMode: 'plan-mode',
        attempts: 0,
      });
      const cfg = createTestConfig({ release: { enabled: true } });

      const orchestrator = createOrchestrator(cfg);
      await expect(
        orchestrator.applyGateAction(42, { action: 'reject', feedback: 'nope' }),
      ).rejects.toBeInstanceOf(GateActionError);
    });

    it('reject on review gate: transitions to queued + writes review-history + initPhaseProgress + emits gate:rejected', async () => {
      attachStatefulTracker({
        issueIid: 42,
        branchName: 'feat/issue-42',
        state: IssueState.PhaseWaiting,
        currentPhase: 'review',
        orchestrationState: { kind: 'gate-waiting', phaseId: 'review', reason: 'human-review' },
        phaseProgress: {
          plan: { status: 'completed' },
          review: { status: 'gate_waiting' },
          build: { status: 'pending' },
          verify: { status: 'pending' },
        },
        pipelineMode: 'plan-mode',
        attempts: 0,
      });
      const rejectEvents = captureEvent('gate:rejected');

      const orchestrator = createOrchestrator();
      mockTracker.store.savePlan(42, JSON.parse(structuredPlanOutput()));
      await suspendAtReview(mockTracker as any, 42);
      await orchestrator.applyGateAction(42, { action: 'reject', feedback: '需要补充错误处理' }, 1);

      const record = mockTracker.get(42);
      expect(record?.state).toBe(IssueState.Pending);
      expect(record?.currentPhase).toBeUndefined();
      expect(record?.orchestrationState).toEqual({ kind: 'queued' });

      expect(record?.phaseHistory).toContainEqual(expect.objectContaining({ phaseId: 'review', outcome: 'gate-rejected' }));
      expect(Object.values(record?.phaseProgress ?? {}).every((progress: any) => progress.status === 'pending')).toBe(true);
      expect(record?.run?.reviewHistory).toHaveLength(1);

      // 关键副作用 3：发出统一的 gate:rejected 事件（取代老 review:rejected）
      expect(rejectEvents).toHaveLength(1);
      expect(rejectEvents[0].data).toMatchObject({
        issueIid: 42, phaseId: 'review', feedback: '需要补充错误处理',
      });
    });
  });
});
