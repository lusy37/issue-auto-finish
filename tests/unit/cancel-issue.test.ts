import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IssueState } from '../../src/tracker/IssueState.js';
import {
  createMockGitOperations,
  createMockGitHubClient,
  createMockAIRunner,
  createMockIssueTracker,
  createTestConfig,
} from '../helpers/mock-factories.js';

// --- mocks ---

const mockWtGitInstance = createMockGitOperations();
vi.mock('../../src/git/GitOperations.js', () => ({
  GitOperations: vi.fn().mockImplementation(() => mockWtGitInstance),
}));

vi.mock('../../src/persistence/PlanPersistence.js', () => ({
  PlanPersistence: vi.fn().mockImplementation(() => ({
    baseDir: '/tmp/test',
    ensureDir: vi.fn(),
    updatePhaseProgress: vi.fn(),
    updatePhaseSessionId: vi.fn(),
  })),
}));

vi.mock('../../src/phases/PhaseFactory.js', () => ({
  createPhase: vi.fn().mockImplementation((name: string) => ({
    phaseName: name,
    run: vi.fn().mockResolvedValue({ status: 'completed', output: 'ok', exitCode: 0 }),
    getResultFiles: vi.fn().mockReturnValue([]),
    setWtGitMap: vi.fn(),
  })),
}));

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
      if (typeof fn === 'function' && '__mocked' in fn) {
        return vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
      }
      return original.promisify(fn as never);
    },
  };
});

vi.mock('../../src/knowledge/index.js', () => ({
  getProjectKnowledge: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/deploy/PortAllocator.js', () => ({
  PortAllocator: vi.fn().mockImplementation(() => ({
    allocate: vi.fn().mockResolvedValue({ backendPort: 14001, frontendPort: 19001 }),
    release: vi.fn(),
    restore: vi.fn(),
    getPortsForIssue: vi.fn().mockReturnValue(null),
  })),
}));

vi.mock('../../src/deploy/DevServerManager.js', () => ({
  DevServerManager: vi.fn().mockImplementation(() => ({
    startServers: vi.fn().mockResolvedValue(undefined),
    stopServers: vi.fn(),
    getStatus: vi.fn().mockReturnValue({ running: false }),
    stopAll: vi.fn(),
  })),
}));

vi.mock('../../src/e2e/ScreenshotPublisher.js', () => ({
  ScreenshotPublisher: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/e2e/E2eSettings.js', () => ({
  isE2eEnabledForIssue: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/notesync/NoteSyncSettings.js', () => ({
  isNoteSyncEnabledForIssue: vi.fn().mockReturnValue(false),
}));

// --- import after mocks ---

import { PipelineOrchestrator } from '../../src/orchestrator/PipelineOrchestrator.js';
import { GitHubClient } from '../../src/clients/GitHubClient.js';

function makeTrackerRecord(number: number, overrides?: Record<string, unknown>) {
  return {
    state: IssueState.PhaseRunning,
    branchName: `feat/issue-${number}`,
    pipelineMode: 'plan-mode',
    currentPhase: 'plan',
    attempts: 1,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    demandSpec: {
      demandId: `gh-${number}`,
      sourceRef: {
        source: 'github-issue',
        externalId: '100',
        displayId: String(number),
      },
      title: 'Test Issue',
      description: 'desc',
      createdAt: '2024-01-01T00:00:00Z',
    },
    ...overrides,
  };
}

describe('cancelIssue', () => {
  let config: ReturnType<typeof createTestConfig>;
  let github: ReturnType<typeof createMockGitHubClient>;
  let mainGit: ReturnType<typeof createMockGitOperations>;
  let aiRunner: ReturnType<typeof createMockAIRunner>;
  let tracker: ReturnType<typeof createMockIssueTracker>;
  let orch: PipelineOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    config = createTestConfig();
    github = createMockGitHubClient();
    mainGit = createMockGitOperations();
    aiRunner = createMockAIRunner();
    tracker = createMockIssueTracker();

    orch = new PipelineOrchestrator(
      config,
      github as unknown as GitHubClient,
      mainGit as any,
      aiRunner as any,
      tracker as any,
    );
  });

  it('调用链完整性：kill AI → 停预览 → 移标签 → 清 worktree → 标记 Cancelled', async () => {
    const number = 42;
    tracker.get.mockReturnValue(makeTrackerRecord(number));

    await orch.cancelIssue(number);

    // 1. 终止 AI 进程
    expect(aiRunner.killByWorkDir).toHaveBeenCalledWith(
      expect.stringContaining(`issue-${number}`),
    );

    // 2. 移除GitHub标签
    expect(github.removeLabelsWithPrefix).toHaveBeenCalledWith(42, 'auto-finish');

    // 3. 清理 worktree
    expect(mainGit.worktreeRemove).toHaveBeenCalledWith(
      expect.stringContaining(`issue-${number}`),
      true,
    );

    // 4. 删除本地和远程分支
    expect(mainGit.deleteBranch).toHaveBeenCalledWith(`feat/issue-${number}`);
    expect(mainGit.deleteRemoteBranch).toHaveBeenCalledWith(`feat/issue-${number}`);

    // 5. 标记为 Skipped（防止 discovery 重新拾取）
    expect(tracker.updateState).toHaveBeenCalledWith(number, IssueState.Cancelled);
  });

  it('IssueNotFoundError — tracker 中不存在时抛出', async () => {
    tracker.get.mockReturnValue(undefined);
    await expect(orch.cancelIssue(999)).rejects.toThrow(/not found/i);
  });

  it('标签移除失败不阻塞后续步骤', async () => {
    const number = 42;
    tracker.get.mockReturnValue(makeTrackerRecord(number));
    github.removeLabelsWithPrefix.mockRejectedValue(new Error('API timeout'));

    // 不应抛出
    await orch.cancelIssue(number);

    // 后续步骤仍然执行
    expect(mainGit.worktreeRemove).toHaveBeenCalled();
    expect(mainGit.deleteBranch).toHaveBeenCalled();
    expect(tracker.updateState).toHaveBeenCalledWith(number, IssueState.Cancelled);
  });

  it('worktree 清理失败不阻塞后续步骤', async () => {
    const number = 42;
    tracker.get.mockReturnValue(makeTrackerRecord(number));
    mainGit.worktreeRemove.mockRejectedValue(new Error('worktree not found'));

    await orch.cancelIssue(number);

    // 分支删除和状态更新仍执行
    expect(mainGit.deleteBranch).toHaveBeenCalled();
    expect(tracker.updateState).toHaveBeenCalledWith(number, IssueState.Cancelled);
  });
});

describe('abortIssue', () => {
  let config: ReturnType<typeof createTestConfig>;
  let github: ReturnType<typeof createMockGitHubClient>;
  let mainGit: ReturnType<typeof createMockGitOperations>;
  let aiRunner: ReturnType<typeof createMockAIRunner>;
  let tracker: ReturnType<typeof createMockIssueTracker>;
  let orch: PipelineOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    config = createTestConfig();
    github = createMockGitHubClient();
    mainGit = createMockGitOperations();
    aiRunner = createMockAIRunner();
    tracker = createMockIssueTracker();
    orch = new PipelineOrchestrator(
      config,
      github as unknown as GitHubClient,
      mainGit as any,
      aiRunner as any,
      tracker as any,
    );
  });

  it('PhaseRunning 状态下 abort 会设置 pendingAction 并 kill AI', () => {
    const number = 10;
    tracker.get.mockReturnValue(makeTrackerRecord(number, { state: IssueState.PhaseRunning, currentPhase: 'build' }));
    orch.abortIssue(number);
    expect(aiRunner.killByWorkDir).toHaveBeenCalledWith(expect.stringContaining(`issue-${number}`));
  });

  it('PhaseDone 状态下 abort 直接调用 pauseIssue', () => {
    const number = 11;
    tracker.get.mockReturnValue(makeTrackerRecord(number, { state: IssueState.PhaseDone, currentPhase: 'plan' }));
    orch.abortIssue(number);
    expect(tracker.pauseIssue).toHaveBeenCalledWith(number, 'plan');
  });

  it('非法状态抛出 InvalidOperationError', () => {
    const number = 12;
    tracker.get.mockReturnValue(makeTrackerRecord(number, { state: IssueState.Completed }));
    expect(() => orch.abortIssue(number)).toThrow();
  });
});

describe('continueIssue', () => {
  let config: ReturnType<typeof createTestConfig>;
  let github: ReturnType<typeof createMockGitHubClient>;
  let mainGit: ReturnType<typeof createMockGitOperations>;
  let aiRunner: ReturnType<typeof createMockAIRunner>;
  let tracker: ReturnType<typeof createMockIssueTracker>;
  let orch: PipelineOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    config = createTestConfig();
    github = createMockGitHubClient();
    mainGit = createMockGitOperations();
    aiRunner = createMockAIRunner();
    tracker = createMockIssueTracker();
    orch = new PipelineOrchestrator(
      config,
      github as unknown as GitHubClient,
      mainGit as any,
      aiRunner as any,
      tracker as any,
    );
  });

  it('Paused 状态调用 resumeFromPause(clearSession=false)', () => {
    const number = 20;
    tracker.get.mockReturnValue(makeTrackerRecord(number, { state: IssueState.Paused, pausedAtPhase: 'build' }));
    tracker.resumeFromPause.mockReturnValue(true);
    orch.continueIssue(number);
    expect(tracker.resumeFromPause).toHaveBeenCalledWith(number, expect.anything(), false);
  });

  it('非 Paused 状态抛出 InvalidOperationError', () => {
    const number = 21;
    tracker.get.mockReturnValue(makeTrackerRecord(number, { state: IssueState.PhaseRunning }));
    expect(() => orch.continueIssue(number)).toThrow();
  });
});

describe('redoPhase', () => {
  let config: ReturnType<typeof createTestConfig>;
  let github: ReturnType<typeof createMockGitHubClient>;
  let mainGit: ReturnType<typeof createMockGitOperations>;
  let aiRunner: ReturnType<typeof createMockAIRunner>;
  let tracker: ReturnType<typeof createMockIssueTracker>;
  let orch: PipelineOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    config = createTestConfig();
    github = createMockGitHubClient();
    mainGit = createMockGitOperations();
    aiRunner = createMockAIRunner();
    tracker = createMockIssueTracker();
    orch = new PipelineOrchestrator(
      config,
      github as unknown as GitHubClient,
      mainGit as any,
      aiRunner as any,
      tracker as any,
    );
  });

  it('Paused 状态调用 resumeFromPause(clearSession=true)', () => {
    const number = 30;
    tracker.get.mockReturnValue(makeTrackerRecord(number, { state: IssueState.Paused, pausedAtPhase: 'build' }));
    tracker.resumeFromPause.mockReturnValue(true);
    orch.redoPhase(number);
    expect(tracker.resumeFromPause).toHaveBeenCalledWith(number, expect.anything(), true);
  });

  it('PhaseRunning 状态下 redo 会设置 pendingAction 并 kill AI', () => {
    const number = 31;
    tracker.get.mockReturnValue(makeTrackerRecord(number, { state: IssueState.PhaseRunning, currentPhase: 'build' }));
    orch.redoPhase(number);
    expect(aiRunner.killByWorkDir).toHaveBeenCalledWith(expect.stringContaining(`issue-${number}`));
  });
});

describe('GitHubClient.removeLabelsWithPrefix', () => {
  it('精确过滤：移除 auto-finish 和 auto-finish:* 前缀，保留无关标签', async () => {
    const config = {
      apiUrl: 'https://github.example.com',
      token: 'test-token',
      repository: 'test/project',
    };
    const client = new GitHubClient(config);

    // Mock fetch
    const issueLabels = ['auto-finish', 'auto-finish:processing', 'auto-finish:done', 'bug', 'priority:high'];
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 100, labels: issueLabels }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

    vi.stubGlobal('fetch', mockFetch);

    await client.removeLabelsWithPrefix(100, 'auto-finish');

    // 第二次 fetch 调用是 updateIssueLabels
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const updateCall = mockFetch.mock.calls[1];
    const body = JSON.parse(updateCall[1].body);
    expect(body.labels).toEqual(['bug', 'priority:high']);

    vi.unstubAllGlobals();
  });

  it('没有匹配标签时不调用 updateIssueLabels', async () => {
    const config = {
      apiUrl: 'https://github.example.com',
      token: 'test-token',
      repository: 'test/project',
    };
    const client = new GitHubClient(config);

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 100, labels: ['bug', 'feature'] }),
      });

    vi.stubGlobal('fetch', mockFetch);

    await client.removeLabelsWithPrefix(100, 'auto-finish');

    // 只调用了 getIssueDetail，没有调用 updateIssueLabels
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });
});
