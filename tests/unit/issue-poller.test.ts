import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IssuePoller } from '../../src/poller/IssuePoller.js';
import { IssueState } from '../../src/tracker/IssueState.js';
import {
  createMockGitHubClient,
  createMockIssueTracker,
  createTestConfig,
  createTestIssue,
} from '../helpers/mock-factories.js';

vi.mock('../../src/orchestrator/IssueService.js');

describe('IssuePoller', () => {
  let config: ReturnType<typeof createTestConfig>;
  let github: ReturnType<typeof createMockGitHubClient>;
  let tracker: ReturnType<typeof createMockIssueTracker>;
  let orchestrator: {
    processIssue: ReturnType<typeof vi.fn>;
    applyGateAction: ReturnType<typeof vi.fn>;
  };
  let poller: IssuePoller;

  beforeEach(() => {
    vi.useFakeTimers();
    config = createTestConfig({
      poll: { intervalMs: 60000, discoveryIntervalMs: 60000, driveIntervalMs: 15000, maxRetries: 3, maxConcurrent: 3 },
    });
    github = createMockGitHubClient();
    tracker = createMockIssueTracker();
    orchestrator = {
      processIssue: vi.fn().mockResolvedValue(undefined),
      applyGateAction: vi.fn().mockResolvedValue(undefined),
    };
    poller = new IssuePoller(config, github as any, tracker as any, orchestrator as any);
  });

  afterEach(() => {
    poller.stop();
    vi.useRealTimers();
  });

  describe('start/stop', () => {
    it('runs discovery and drive immediately on start', () => {
      github.listIssues.mockResolvedValue([]);
      tracker.getDrivableIssues.mockReturnValue([]);

      poller.start();

      expect(github.listIssues).toHaveBeenCalledTimes(1);
    });

    it('stop clears both timers', () => {
      github.listIssues.mockResolvedValue([]);
      tracker.getDrivableIssues.mockReturnValue([]);

      poller.start();
      poller.stop();

      github.listIssues.mockClear();
      tracker.getDrivableIssues.mockClear();

      vi.advanceTimersByTime(120_000);

      expect(github.listIssues).not.toHaveBeenCalled();
    });
  });

  describe('discovery cycle', () => {
    it('creates tracker records for new issues', async () => {
      const issue = createTestIssue({ id: 100, number: 42 });
      tracker.getDrivableIssues.mockReturnValue([]);

      // First discovery: no issues (completes the first-discovery phase)
      github.listIssues.mockResolvedValueOnce([]);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);

      // Second discovery: new issue appears → should be Pending
      github.listIssues.mockResolvedValueOnce([issue]);
      tracker.get.mockReturnValue(undefined);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(tracker.create).toHaveBeenCalledWith(
        expect.objectContaining({
          demandSpec: expect.objectContaining({
            demandId: 'gh-42',
            sourceRef: { source: 'github-issue', externalId: '42', displayId: '42' },
          }),
          state: IssueState.Pending,
        }),
      );
    });

    it('skips issues already tracked', async () => {
      const issue = createTestIssue({ id: 100, number: 42 });
      github.listIssues.mockResolvedValue([issue]);
      tracker.get.mockReturnValue({ state: IssueState.PhaseRunning });
      tracker.getDrivableIssues.mockReturnValue([]);

      poller.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(tracker.create).not.toHaveBeenCalled();
    });

    it('skips issues with auto-finish:done label', async () => {
      const issue = createTestIssue({ labels: ['auto-finish', 'auto-finish:done'] });
      github.listIssues.mockResolvedValue([issue]);
      tracker.get.mockReturnValue(undefined);
      tracker.getDrivableIssues.mockReturnValue([]);

      poller.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(tracker.create).not.toHaveBeenCalled();
    });

    it('runs on discovery interval', async () => {
      github.listIssues.mockResolvedValue([]);
      tracker.getDrivableIssues.mockReturnValue([]);

      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      github.listIssues.mockClear();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(github.listIssues).toHaveBeenCalledTimes(1);
    });

    it('keeps pre-existing issues skipped when the first discovery fails then succeeds', async () => {
      // 复现 bug：首次 discovery 因 429 抛错时，isFirstDiscovery 不应被消耗，
      // 否则后续首个成功发现会把存量历史 issue 误标为 Pending（而非 Skipped）。
      const issue = createTestIssue({ id: 100, number: 42 });
      tracker.getDrivableIssues.mockReturnValue([]);
      tracker.get.mockReturnValue(undefined);

      // 首次 discovery 失败（模拟 429 重试耗尽后抛错）
      github.listIssues.mockRejectedValueOnce(new Error('GitHub API error 429'));
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(tracker.create).not.toHaveBeenCalled();

      // 第二次 discovery 成功并返回存量 issue —— 这才是真正的「首次成功发现」，应标记为 Skipped
      github.listIssues.mockResolvedValueOnce([issue]);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(tracker.create).toHaveBeenCalledWith(
        expect.objectContaining({ state: IssueState.Skipped }),
      );
    });

    it('does not start overlapping discovery cycles while one is in flight', async () => {
      // 复现 bug：discovery 无重入保护时，高频 timer + 慢请求（429 backoff）会堆叠多个并发
      // discovery，形成 API 风暴。重入保护下，前一个 discovery 未完成则跳过本次 tick。
      tracker.getDrivableIssues.mockReturnValue([]);
      tracker.get.mockReturnValue(undefined);

      let resolveList: (value: unknown) => void = () => {};
      github.listIssues.mockReturnValue(
        new Promise((resolve) => { resolveList = resolve; }),
      );

      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(github.listIssues).toHaveBeenCalledTimes(1);

      // 第一个 discovery 仍卡在 listIssues 期间，推进多个 discovery 间隔
      await vi.advanceTimersByTimeAsync(180_000);
      expect(github.listIssues).toHaveBeenCalledTimes(1);

      resolveList([]);
    });
  });

  describe('drive cycle', () => {
    it('processes drivable issues from tracker', async () => {
      const record = {
        demandSpec: {
          demandId: 'gh-42',
          sourceRef: { source: 'github-issue', externalId: '42', displayId: '42' },
          title: 'Test',
          description: '',
          createdAt: '2024-01-01T00:00:00Z',
        },
        state: IssueState.Pending,
        branchName: 'feat/issue-42',
        attempts: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const issue = createTestIssue({ id: 100, number: 42 });

      github.listIssues.mockResolvedValue([]);
      tracker.getDrivableIssues.mockReturnValue([record]);
      github.getIssueDetail.mockResolvedValue(issue);

      poller.start();
      await vi.advanceTimersByTimeAsync(5000);

      expect(orchestrator.processIssue).toHaveBeenCalledWith(issue);
    });

    it('respects maxConcurrent limit', async () => {
      const records = [1, 2, 3, 4].map((n) => ({
        demandSpec: {
          demandId: `gh-${n}`,
          sourceRef: { source: 'github-issue', externalId: `${n}`, displayId: `${n}` },
          title: `Test${n}`,
          description: '',
          createdAt: '2024-01-01T00:00:00Z',
        },
        state: IssueState.Pending,
        branchName: `feat/issue-${n}`,
        attempts: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));

      // Config maxConcurrent is 3, so only first 3 should start
      github.listIssues.mockResolvedValue([]);
      tracker.getDrivableIssues.mockReturnValue(records);
      orchestrator.processIssue.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 60_000)),
      );
      github.getIssueDetail.mockImplementation(async (id: number) =>
        createTestIssue({ id, number: id / 100 }),
      );

      poller.start();
      await vi.advanceTimersByTimeAsync(5000);

      // Only 3 issues should have been dispatched (maxConcurrent=3)
      expect(orchestrator.processIssue).toHaveBeenCalledTimes(3);
      expect(poller.getActiveIssueIids()).toHaveLength(3);
    });

    it('does not re-dispatch already active issues', async () => {
      const record = {
        demandSpec: {
          demandId: 'gh-42',
          sourceRef: { source: 'github-issue', externalId: '42', displayId: '42' },
          title: 'Test',
          description: '',
          createdAt: '2024-01-01T00:00:00Z',
        },
        state: IssueState.Pending,
        branchName: 'feat/issue-42',
        attempts: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const issue = createTestIssue({ id: 100, number: 42 });

      github.listIssues.mockResolvedValue([]);
      tracker.getDrivableIssues.mockReturnValue([record]);
      orchestrator.processIssue.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 60_000)),
      );
      github.getIssueDetail.mockResolvedValue(issue);

      poller.start();
      await vi.advanceTimersByTimeAsync(5000);

      expect(orchestrator.processIssue).toHaveBeenCalledTimes(1);

      // Next drive tick: same record still drivable but already active
      orchestrator.processIssue.mockClear();
      await vi.advanceTimersByTimeAsync(15_000);

      expect(orchestrator.processIssue).not.toHaveBeenCalled();
    });

    it('runs at drive interval (shorter than discovery)', async () => {
      github.listIssues.mockResolvedValue([]);
      tracker.getDrivableIssues.mockReturnValue([]);

      poller.start();
      await vi.advanceTimersByTimeAsync(5000);
      tracker.getDrivableIssues.mockClear();

      await vi.advanceTimersByTimeAsync(15_000);
      expect(tracker.getDrivableIssues).toHaveBeenCalledTimes(1);

      tracker.getDrivableIssues.mockClear();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(tracker.getDrivableIssues).toHaveBeenCalledTimes(1);
    });

    it('continues to next issue on failure', async () => {
      const record1 = {
        demandSpec: {
          demandId: 'gh-42',
          sourceRef: { source: 'github-issue', externalId: '42', displayId: '42' },
          title: 'Test1',
          description: '',
          createdAt: '2024-01-01T00:00:00Z',
        },
        state: IssueState.Pending, branchName: 'feat/issue-42',
        attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      const record2 = {
        demandSpec: {
          demandId: 'gh-43',
          sourceRef: { source: 'github-issue', externalId: '43', displayId: '43' },
          title: 'Test2',
          description: '',
          createdAt: '2024-01-01T00:00:00Z',
        },
        state: IssueState.Pending, branchName: 'feat/issue-43',
        attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      const issue1 = createTestIssue({ id: 100, number: 42 });
      const issue2 = createTestIssue({ id: 200, number: 43 });

      github.listIssues.mockResolvedValue([]);
      tracker.getDrivableIssues.mockReturnValue([record1, record2]);
      github.getIssueDetail
        .mockResolvedValueOnce(issue1)
        .mockResolvedValueOnce(issue2);
      orchestrator.processIssue
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce(undefined);

      poller.start();
      await vi.advanceTimersByTimeAsync(5000);

      expect(orchestrator.processIssue).toHaveBeenCalledTimes(2);
    });

    it('self-heals when acquireProcessingLock throws (EDQUOT) — continues to next issue', async () => {
      // Bug repro：tracker.save 在 EDQUOT 时抛错，会让 acquireProcessingLock 抛出。
      // 修复后：drive 应捕获异常、跳过当前 issue、不影响 batch 中后续 issue，
      // 也不触发 uncaughtException 让进程崩溃。
      const record1 = {
        demandSpec: {
          demandId: 'gh-42',
          sourceRef: { source: 'github-issue', externalId: '42', displayId: '42' },
          title: 'Test1', description: '', createdAt: '2024-01-01T00:00:00Z',
        },
        state: IssueState.Pending, branchName: 'feat/issue-42',
        attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      const record2 = {
        demandSpec: {
          demandId: 'gh-43',
          sourceRef: { source: 'github-issue', externalId: '43', displayId: '43' },
          title: 'Test2', description: '', createdAt: '2024-01-01T00:00:00Z',
        },
        state: IssueState.Pending, branchName: 'feat/issue-43',
        attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      github.listIssues.mockResolvedValue([]);
      tracker.getDrivableIssues.mockReturnValue([record1, record2]);
      tracker.acquireProcessingLock
        .mockImplementationOnce(() => {
          const err = new Error('Disk quota exceeded') as NodeJS.ErrnoException;
          err.code = 'EDQUOT';
          err.errno = -122;
          throw err;
        })
        .mockReturnValueOnce(true);
      github.getIssueDetail.mockResolvedValue(createTestIssue({ id: 200, number: 43 }));

      poller.start();
      await vi.advanceTimersByTimeAsync(5000);

      // 第一个 issue 应该因 EDQUOT 被跳过，第二个仍能正常派发
      expect(tracker.acquireProcessingLock).toHaveBeenCalledTimes(2);
      expect(orchestrator.processIssue).toHaveBeenCalledTimes(1);
      expect(orchestrator.processIssue).toHaveBeenCalledWith(expect.objectContaining({ number: 43 }));
    });

    it('does not crash when drive throws synchronously — continues on next tick', async () => {
      // 兜底：safeDrive 包了 try/catch，确保未来代码改动引入的同步异常也不会击穿进程
      github.listIssues.mockResolvedValue([]);
      tracker.getDrivableIssues.mockImplementationOnce(() => {
        throw new Error('synthetic drive failure');
      });

      // 不应抛出
      expect(() => poller.start()).not.toThrow();
      await vi.advanceTimersByTimeAsync(5000);

      // 下个 tick 应仍然能调用（说明 timer 没死）
      tracker.getDrivableIssues.mockReturnValue([]);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(tracker.getDrivableIssues).toHaveBeenCalledTimes(2);
    });

    it('skips issue when API detail fetch fails', async () => {
      const record = {
        demandSpec: {
          demandId: 'gh-42',
          sourceRef: { source: 'github-issue', externalId: '42', displayId: '42' },
          title: 'Test',
          description: '',
          createdAt: '2024-01-01T00:00:00Z',
        },
        state: IssueState.Pending, branchName: 'feat/issue-42',
        attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };

      github.listIssues.mockResolvedValue([]);
      tracker.getDrivableIssues.mockReturnValue([record]);
      github.getIssueDetail.mockRejectedValue(new Error('API error'));

      poller.start();
      await vi.advanceTimersByTimeAsync(5000);

      expect(orchestrator.processIssue).not.toHaveBeenCalled();
    });
  });

  describe('auto-approve waiting issues', () => {
    it.each([true, false])('审核开关为 %s 时，已等待任务的标签规则只在开启时执行', async enabled => {
      const cfg = createTestConfig({
        poll: { intervalMs: 60000, discoveryIntervalMs: 60000, driveIntervalMs: 15000, maxRetries: 3, maxConcurrent: 3 },
        review: { enabled, autoApproveLabels: ['skip-review'] },
      });
      const waitingRecord = {
        run: { planRevision: 1 },
        demandSpec: {
          demandId: 'gh-42',
          sourceRef: { source: 'github-issue', externalId: '42', displayId: '42' },
          title: 'Test',
          description: '',
          createdAt: '2024-01-01T00:00:00Z',
        },
        // 必须显式设置 currentPhase='review'，否则 Bug 3 修复后会跳过非 review gate
        state: IssueState.PhaseWaiting, currentPhase: 'review', branchName: 'feat/issue-42',
        attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };

      github.listIssues.mockResolvedValue([]);
      tracker.getDrivableIssues.mockReturnValue([]);
      tracker.getAll.mockReturnValue([waitingRecord]);
      github.getIssueDetail.mockResolvedValue(
        createTestIssue({ id: 100, number: 42, labels: ['auto-finish', 'skip-review'] }),
      );

      const p = new IssuePoller(cfg, github as any, tracker as any, orchestrator as any);
      p.start();
      await vi.advanceTimersByTimeAsync(5000);

      // PR4 之后 IssuePoller 应通过正统的 orchestrator.applyGateAction 进行批准，
      // 由 Reducer + TrackerStateStore 统一维护 orchestrationState/phaseProgress/phaseHistory，
      // 而不是直接调 tracker.updateState（老路径会绕过 phaseProgress 同步，导致前端样式错误）。
      if (enabled) expect(orchestrator.applyGateAction).toHaveBeenCalledWith(42, { action: 'approve', source: 'label' }, 1);
      else expect(orchestrator.applyGateAction).not.toHaveBeenCalled();
      p.stop();
    });

    it('does NOT auto-approve when currentPhase is not review (Bug 3 regression — release/uat gate)', async () => {
      // 防止 IssuePoller.autoApproveByLabels 把 release-gate 处的 PhaseWaiting
      // 误判为 review，从而错误地把 currentPhase 覆盖为 review。
      const cfg = createTestConfig({
        poll: { intervalMs: 60000, discoveryIntervalMs: 60000, driveIntervalMs: 15000, maxRetries: 3, maxConcurrent: 3 },
        review: { enabled: true, autoApproveLabels: ['skip-review'] },
      });
      const waitingAtReleaseGate = {
        demandSpec: {
          demandId: 'gh-42',
          sourceRef: { source: 'github-issue', externalId: '42', displayId: '42' },
          title: 'Test',
          description: '',
          createdAt: '2024-01-01T00:00:00Z',
        },
        state: IssueState.PhaseWaiting,
        currentPhase: 'release', // ← release gate，不是 review
        branchName: 'feat/issue-42',
        attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };

      github.listIssues.mockResolvedValue([]);
      tracker.getDrivableIssues.mockReturnValue([]);
      tracker.getAll.mockReturnValue([waitingAtReleaseGate]);
      // 即便 issue 带了 auto-approve label，对 release-gate 也不应触发自动批准
      github.getIssueDetail.mockResolvedValue(
        createTestIssue({ id: 100, number: 42, labels: ['auto-finish', 'skip-review'] }),
      );

      const p = new IssuePoller(cfg, github as any, tracker as any, orchestrator as any);
      p.start();
      await vi.advanceTimersByTimeAsync(5000);

      // 关键：不应当调用 updateState 把 currentPhase 改成 review
      expect(tracker.updateState).not.toHaveBeenCalled();
      p.stop();
    });

    it('does not auto-approve when labels do not match', async () => {
      const cfg = createTestConfig({
        poll: { intervalMs: 60000, discoveryIntervalMs: 60000, driveIntervalMs: 15000, maxRetries: 3, maxConcurrent: 3 },
        review: { enabled: true, autoApproveLabels: ['skip-review'] },
      });
      const waitingRecord = {
        run: { planRevision: 1 },
        demandSpec: {
          demandId: 'gh-42',
          sourceRef: { source: 'github-issue', externalId: '42', displayId: '42' },
          title: 'Test',
          description: '',
          createdAt: '2024-01-01T00:00:00Z',
        },
        state: IssueState.PhaseWaiting, branchName: 'feat/issue-42',
        attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };

      github.listIssues.mockResolvedValue([]);
      tracker.getDrivableIssues.mockReturnValue([]);
      tracker.getAll.mockReturnValue([waitingRecord]);
      github.getIssueDetail.mockResolvedValue(
        createTestIssue({ id: 100, number: 42, labels: ['auto-finish'] }),
      );

      const p = new IssuePoller(cfg, github as any, tracker as any, orchestrator as any);
      p.start();
      await vi.advanceTimersByTimeAsync(5000);

      expect(tracker.updateState).not.toHaveBeenCalled();
      p.stop();
    });

    it('skips auto-approve check when autoApproveLabels is empty', async () => {
      const waitingRecord = {
        run: { planRevision: 1 },
        demandSpec: {
          demandId: 'gh-42',
          sourceRef: { source: 'github-issue', externalId: '42', displayId: '42' },
          title: 'Test',
          description: '',
          createdAt: '2024-01-01T00:00:00Z',
        },
        state: IssueState.PhaseWaiting, branchName: 'feat/issue-42',
        attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };

      github.listIssues.mockResolvedValue([]);
      tracker.getDrivableIssues.mockReturnValue([]);
      tracker.getAll.mockReturnValue([waitingRecord]);

      poller.start();
      await vi.advanceTimersByTimeAsync(5000);

      expect(github.getIssueDetail).not.toHaveBeenCalled();
      expect(tracker.updateState).not.toHaveBeenCalled();
    });

    it('throttles auto-approve checks to 30s interval', async () => {
      const cfg = createTestConfig({
        poll: { intervalMs: 60000, discoveryIntervalMs: 60000, driveIntervalMs: 1000, maxRetries: 3, maxConcurrent: 3 },
        review: { enabled: true, autoApproveLabels: ['skip-review'] },
      });
      const waitingRecord = {
        run: { planRevision: 1 },
        demandSpec: {
          demandId: 'gh-42',
          sourceRef: { source: 'github-issue', externalId: '42', displayId: '42' },
          title: 'Test',
          description: '',
          createdAt: '2024-01-01T00:00:00Z',
        },
        state: IssueState.PhaseWaiting, currentPhase: 'review', branchName: 'feat/issue-42',
        attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };

      github.listIssues.mockResolvedValue([]);
      tracker.getDrivableIssues.mockReturnValue([]);
      tracker.getAll.mockReturnValue([waitingRecord]);
      github.getIssueDetail.mockResolvedValue(
        createTestIssue({ id: 100, number: 42, labels: ['auto-finish'] }),
      );

      const p = new IssuePoller(cfg, github as any, tracker as any, orchestrator as any);
      p.start();
      await vi.advanceTimersByTimeAsync(5000);

      // First call happens immediately
      expect(github.getIssueDetail).toHaveBeenCalledTimes(1);
      github.getIssueDetail.mockClear();

      // Drive runs again at 1s, but auto-approve check is throttled (30s interval)
      await vi.advanceTimersByTimeAsync(5_000);
      expect(github.getIssueDetail).not.toHaveBeenCalled();

      // After 30s total, the check runs again
      await vi.advanceTimersByTimeAsync(25_000);
      expect(github.getIssueDetail).toHaveBeenCalledTimes(1);

      p.stop();
    });
  });
});
