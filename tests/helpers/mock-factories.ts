import type { GitOperations } from '../../src/git/GitOperations.js';
import type { GitHubClient } from '../../src/clients/GitHubClient.js';
import type { RunOptions } from '../../src/ai-runner/AIRunner.js';
import { newIssueRun, type PlanContent } from '../../src/dag/contracts.js';
import { vi } from 'vitest';
import type { Config } from '../../src/config.js';
import type { GitHubIssue } from '../../src/clients/GitHubClient.js';
import type { RunResult } from '../../src/ai-runner/index.js';
import type {
  CoreDeps,
  GitDeps,
  AIDeps,
  PreviewDeps,
  PolicyDeps,
  OrchestratorDeps,
} from '../../src/orchestrator/IssueProcessingContext.js';
import { EventBus } from '../../src/events/EventBus.js';

export function createMockGitOperations() {
  return {
    fetch: vi.fn<(...args: Parameters<GitOperations['fetch']>) => Promise<void>>().mockResolvedValue(undefined),
    resetOwned: vi.fn<(...args: Parameters<GitOperations['resetOwned']>) => Promise<void>>().mockResolvedValue(undefined),
    fetchAndPull: vi.fn<(...args: Parameters<GitOperations['fetchAndPull']>) => Promise<void>>().mockResolvedValue(undefined),
    createBranch: vi.fn<(...args: Parameters<GitOperations['createBranch']>) => Promise<void>>().mockResolvedValue(undefined),
    checkout: vi.fn<(...args: Parameters<GitOperations['checkout']>) => Promise<void>>().mockResolvedValue(undefined),
    add: vi.fn<(...args: Parameters<GitOperations['add']>) => Promise<void>>().mockResolvedValue(undefined),
    commit: vi.fn<(...args: Parameters<GitOperations['commit']>) => Promise<void>>().mockResolvedValue(undefined),
    push: vi.fn<(...args: Parameters<GitOperations['push']>) => Promise<void>>().mockResolvedValue(undefined),
    branchExists: vi.fn<(...args: Parameters<GitOperations['branchExists']>) => Promise<boolean>>().mockResolvedValue(false),
    remoteBranchExists: vi.fn<(...args: Parameters<GitOperations['remoteBranchExists']>) => Promise<boolean>>().mockResolvedValue(false),
    getCurrentBranch: vi.fn<(...args: Parameters<GitOperations['getCurrentBranch']>) => Promise<string>>().mockResolvedValue('master'),
    hasChanges: vi.fn<(...args: Parameters<GitOperations['hasChanges']>) => Promise<boolean>>().mockResolvedValue(false),
    stash: vi.fn<(...args: Parameters<GitOperations['stash']>) => Promise<void>>().mockResolvedValue(undefined),
    stashPop: vi.fn<(...args: Parameters<GitOperations['stashPop']>) => Promise<void>>().mockResolvedValue(undefined),
    addAndCommit: vi.fn<(...args: Parameters<GitOperations['addAndCommit']>) => Promise<void>>().mockResolvedValue(undefined),
    addCommitAndPush: vi.fn<(...args: Parameters<GitOperations['addCommitAndPush']>) => Promise<void>>().mockResolvedValue(undefined),
    checkoutTrack: vi.fn<(...args: Parameters<GitOperations['checkoutTrack']>) => Promise<void>>().mockResolvedValue(undefined),
    worktreeAdd: vi.fn<(...args: Parameters<GitOperations['worktreeAdd']>) => Promise<void>>().mockResolvedValue(undefined),
    worktreeAddExisting: vi.fn<(...args: Parameters<GitOperations['worktreeAddExisting']>) => Promise<void>>().mockResolvedValue(undefined),
    worktreeAddTracking: vi.fn<(...args: Parameters<GitOperations['worktreeAddTracking']>) => Promise<void>>().mockResolvedValue(undefined),
    worktreeRemove: vi.fn<(...args: Parameters<GitOperations['worktreeRemove']>) => Promise<void>>().mockResolvedValue(undefined),
    worktreePrune: vi.fn<(...args: Parameters<GitOperations['worktreePrune']>) => Promise<void>>().mockResolvedValue(undefined),
    worktreeList: vi.fn<(...args: Parameters<GitOperations['worktreeList']>) => Promise<string[]>>().mockResolvedValue([]),
    deleteBranch: vi.fn<(...args: Parameters<GitOperations['deleteBranch']>) => Promise<void>>().mockResolvedValue(undefined),
    deleteRemoteBranch: vi.fn<(...args: Parameters<GitOperations['deleteRemoteBranch']>) => Promise<void>>().mockResolvedValue(undefined),
    isRebaseInProgress: vi.fn<(...args: Parameters<GitOperations['isRebaseInProgress']>) => Promise<boolean>>().mockResolvedValue(false),
    rebaseAbort: vi.fn<(...args: Parameters<GitOperations['rebaseAbort']>) => Promise<void>>().mockResolvedValue(undefined),
    showFile: vi.fn<(...args: Parameters<GitOperations['showFile']>) => Promise<string | null>>().mockResolvedValue(null),
    refExists: vi.fn<(...args: Parameters<GitOperations['refExists']>) => Promise<boolean>>().mockResolvedValue(true),
  };
}

export function createMockGitHubClient() {
  return {
    listIssues: vi.fn<(...args: Parameters<GitHubClient['listIssues']>) => Promise<GitHubIssue[]>>().mockResolvedValue([]),
    listIssuesAdvanced: vi.fn().mockResolvedValue({ issues: [], total: 0 }),
    getIssueDetail: vi.fn<(...args: Parameters<GitHubClient['getIssueDetail']>) => Promise<GitHubIssue>>(),
    createIssueNote: vi.fn<(...args: Parameters<GitHubClient['createIssueNote']>) => Promise<void>>().mockResolvedValue(undefined),
    updateIssueLabels: vi.fn<(...args: Parameters<GitHubClient['updateIssueLabels']>) => Promise<void>>().mockResolvedValue(undefined),
    addLabel: vi.fn<(...args: Parameters<GitHubClient['addLabel']>) => Promise<void>>().mockResolvedValue(undefined),
    createPullRequest: vi.fn().mockResolvedValue({
      id: 1, number: 1, title: 'test PR', html_url: 'https://github.example.com/pr/1', state: 'open',
    }),
    createPullRequestNote: vi.fn<(...args: Parameters<GitHubClient['createPullRequestNote']>) => Promise<void>>().mockResolvedValue(undefined),
    uploadFile: vi.fn().mockResolvedValue({
      alt: 'screenshot', url: '/uploads/hash/screenshot.png', markdown: '![screenshot](/uploads/hash/screenshot.png)',
    }),
    findPullRequestByBranch: vi.fn().mockResolvedValue(null),
    closePullRequest: vi.fn<(...args: Parameters<GitHubClient['closePullRequest']>) => Promise<void>>().mockResolvedValue(undefined),
    deleteIssue: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    closeIssue: vi.fn<(...args: Parameters<GitHubClient['closeIssue']>) => Promise<void>>().mockResolvedValue(undefined),
    createIssue: vi.fn().mockResolvedValue({
      id: 200, number: 99, title: 'Created Issue', description: 'desc', state: 'open',
      labels: ['auto-finish'], created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
      author: { username: 'testuser', name: 'Test User' },
    }),
    listIssueNotes: vi.fn().mockResolvedValue([]),
    deleteIssueNote: vi.fn<(...args: Parameters<GitHubClient['deleteIssueNote']>) => Promise<void>>().mockResolvedValue(undefined),
    cleanupAgentNotes: vi.fn<(...args: Parameters<GitHubClient['cleanupAgentNotes']>) => Promise<number>>().mockResolvedValue(0),
    removeLabelsWithPrefix: vi.fn<(...args: Parameters<GitHubClient['removeLabelsWithPrefix']>) => Promise<void>>().mockResolvedValue(undefined),
    getCurrentUser: vi.fn().mockResolvedValue({ id: 1, username: 'bot-user', name: 'Bot User' }),
    setIssueAssignee: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    clearIssueAssignee: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    updateIssueNote: vi.fn<(...args: Parameters<GitHubClient['updateIssueNote']>) => Promise<void>>().mockResolvedValue(undefined),
    createIssueNotePlain: vi.fn().mockResolvedValue({ id: 999, body: '', author: { username: 'bot-user', name: 'Bot' }, created_at: '2024-01-01T00:00:00Z' }),
  };
}

export function createMockAIRunner() {
  const defaultResult: RunResult = {
    success: true,
    output: 'ok',
    sessionId: 'test-session',
    exitCode: 0,
  };
  return {
    run: vi.fn<(options: RunOptions) => Promise<RunResult>>().mockResolvedValue(defaultResult),
    killAll: vi.fn(),
    killByWorkDir: vi.fn().mockReturnValue(0),
  };
}

let mockStoreSequence = 0;
export function createMockIssueTracker() {
  const storeId = ++mockStoreSequence;
  const tracker = {
    transaction: vi.fn((number: number, update: (record: any) => void) => {
      const record = tracker.get(number);
      if (!record) throw new Error(`Issue #${number} 不存在`);
      record.run ??= newIssueRun();
      update(record); record.run.version++;
      return record;
    }),
    assertIdentity: vi.fn(),
    store: {
      file: (number: number) => 'mock-store-' + storeId + '/' + number,
      get: (number: number) => tracker.get(number),
      transaction: (number: number, update: (record: any) => void) => tracker.transaction(number, update),
      dataDir: process.env.DATA_DIR!, isBlocked: vi.fn().mockReturnValue(false),
      savePlan: vi.fn((number: number, content: PlanContent) => {
        const record = tracker.get(number); record.run ??= newIssueRun();
        const revision = ++record.run.planRevision;
        record.run.review = { revision, decision: 'waiting' };
        if (record.lifecycle?.kind === 'waiting' && record.lifecycle.phase === 'review') {
          record.lifecycle = { ...record.lifecycle, planRevision: revision };
        }
        record.run.planDigest = 'mock-digest';
        const plan = { ...content, revision, digest: 'mock-digest', demand: record.demandSpec };
        tracker.store.readPlan.mockReturnValue(plan);
        return plan;
      }),
      readPlan: vi.fn(),
    },
    get: vi.fn(),
    create: vi.fn().mockImplementation((record: Record<string, unknown>) => ({
      ...record,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    clearPhaseHistory: vi.fn(),
    initPhaseProgress: vi.fn(),
    updatePhaseProgress: vi.fn(),
    getPhaseProgress: vi.fn(),
    emitFailure: vi.fn(),
    markFailed: vi.fn(),
    isProcessing: vi.fn().mockReturnValue(false),
    isCompleted: vi.fn().mockReturnValue(false),
    canRetry: vi.fn().mockReturnValue(false),
    isStalled: vi.fn().mockReturnValue(false),
    getDrivableIssues: vi.fn().mockReturnValue([]),
    getAllActive: vi.fn().mockReturnValue([]),
    getAll: vi.fn().mockReturnValue([]),
    resetForRetry: vi.fn().mockReturnValue(false),
    resetFull: vi.fn().mockReturnValue(false),
    resetToPhase: vi.fn().mockReturnValue(false),
    pauseIssue: vi.fn().mockReturnValue(true),
    resumeFromPause: vi.fn().mockReturnValue(true),
    delete: vi.fn().mockReturnValue(false),
    acquireProcessingLock: vi.fn().mockReturnValue(true),
    releaseProcessingLock: vi.fn(),
    clearProcessingLock: vi.fn(),
  };
  return tracker;
}

export type TestConfigOverrides = { [K in keyof Config]?: Config[K] extends object ? Partial<Config[K]> : Config[K] };

export function createTestConfig(overrides?: TestConfigOverrides): Config {
  return {
    github: {
      apiUrl: 'https://github.example.com',
      token: 'test-token',
      repository: 'test/project',
      ...overrides?.github,
    },
    project: {
      workDir: '/tmp/test-workdir',
      gitRootDir: '/tmp/test-gitroot',
      baseBranch: 'master',
      branchPrefix: 'feat/issue',
      worktreeBaseDir: '/tmp/test-worktrees',
      projectSubDir: 'app/mmpayxdcdevopslogicsvr',
      ...overrides?.project,
    },
    ai: {
      maxConcurrency: 4,
      idleTimeoutMs: 1200000,
      timeoutGraceMs: 60000,
      timeoutExtensionMs: 600000,
      timeoutMaxExtensions: 3,
      mode: 'codex',
      binary: '',
      phaseTimeoutMs: 1800000,
      model: 'test-codex-model',
      ...overrides?.ai,
    },
    poll: {
      discoveryIntervalMs: 60000,
      driveIntervalMs: 15000,
      maxRetries: 3,
      maxConcurrent: 3,
      ...overrides?.poll,
    },
    pipeline: {
      mode: 'auto',
      ...overrides?.pipeline,
    },
    review: {
      enabled: true,
      autoApproveLabels: [],
      ...overrides?.review,
    },
    web: {
      host: '0.0.0.0',
      port: 3000,
      frontendDistDir: '/tmp/dist',
      ...overrides?.web,
    },
    issueNoteSync: {
      enabled: true,
      webBaseUrl: 'http://localhost:3000',
      ...overrides?.issueNoteSync,
    },
    e2e: {
      timeoutMs: 300000,
      configFile: 'playwright.config.ts',
      enabled: false,
      baseUrl: 'https://localhost:8890',
      backendPortBase: 14000,
      frontendPortBase: 19000,
      ...overrides?.e2e,
    },
    preview: {
      startupTimeoutMs: 60000,
      readinessIntervalMs: 200,
      backendReadyUrl: '',
      frontendReadyUrl: '',
      backendCommand: '',
      frontendCommand: '',
      frontendDir: '.',
      reapIntervalMs: 300000,
      enabled: false,
      host: '',
      ttlMs: 86400000,
      keepAfterComplete: true,
      ...overrides?.preview,
    },
    worktree: {
      cleanupEnabled: true,
      retentionMs: 604800000,
      cleanupIntervalMs: 3600000,
      ...overrides?.worktree,
    },
    locale: overrides?.locale ?? 'zh-CN',
    knowledge: {
      enabled: true,
      path: overrides?.knowledge?.path,
      ...overrides?.knowledge,
    },
    distill: {
      enabled: true,
      minDiariesForDistill: 3,
      memoryConfidenceThreshold: 0.7,
      ...overrides?.distill,
    },
    verifyFixLoop: {
      enabled: true,
      maxIterations: 3,
      ...overrides?.verifyFixLoop,
    },
  };
}

export function createMockSystemUseCaseAnalyzer() {
  return {
    getCurrentModel: vi.fn().mockReturnValue(null),
    setCurrentModel: vi.fn(),
    analyze: vi.fn().mockResolvedValue({ version: 1, repository: '/tmp', analyzedAt: '', updatedAt: '', actors: [], useCases: [], relationships: [] }),
    suggestDomainAssociations: vi.fn().mockResolvedValue(new Map()),
    confirmToStore: vi.fn(),
    loadFromStore: vi.fn().mockReturnValue(null),
  };
}

export function createMockDomainModelAnalyzer() {
  return {
    getCurrentModel: vi.fn().mockReturnValue(null),
    setCurrentModel: vi.fn(),
    analyze: vi.fn().mockResolvedValue({ version: 1, repository: '/tmp', analyzedAt: '', updatedAt: '', elements: [], relationships: [], boundedContexts: [] }),
    confirmToStore: vi.fn(),
    loadFromStore: vi.fn().mockReturnValue(null),
  };
}

export function createTestIssue(overrides?: Partial<GitHubIssue>): GitHubIssue {
  return {
    id: 100,
    number: 42,
    title: 'Test Issue',
    description: 'Test description',
    state: 'open',
    labels: ['auto-finish'],
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    author: { username: 'testuser', name: 'Test User' },
    ...overrides,
  };
}

export function createMockPlanPersistence() {
  return {
    baseDir: '/tmp/mock-workdir',
    ensureDir: vi.fn(),
    writeIssueMeta: vi.fn(),
    writePlan: vi.fn(),

    readReviewFeedback: vi.fn().mockReturnValue(null),
    readReviewHistory: vi.fn().mockReturnValue([]),

    getAllPlanFiles: vi.fn().mockReturnValue([]),
    readFile: vi.fn().mockReturnValue(null),
    isArtifactReady: vi.fn().mockReturnValue(false),
    writeFile: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// OrchestratorDeps 分组 mock 工厂
// ---------------------------------------------------------------------------

export function createMockCoreDeps(overrides?: Partial<CoreDeps>): CoreDeps {
  return {
    config: createTestConfig(),
    tracker: createMockIssueTracker() as any,
    github: createMockGitHubClient() as any,
    eventBus: new EventBus(),
    emitProgress: vi.fn(),
    ...overrides,
  };
}

export function createMockGitDeps(overrides?: Partial<GitDeps>): GitDeps {
  return {
    mainGit: createMockGitOperations() as any,
    mainGitMutex: { acquire: vi.fn().mockResolvedValue(vi.fn()) } as any,
    ensureWorktree: vi.fn().mockResolvedValue(undefined),
    workspaceManager: { resolveWorkspace: vi.fn() } as any,
    ...overrides,
  };
}

export function createMockAIDeps(overrides?: Partial<AIDeps>): AIDeps {
  return {
    aiRunner: createMockAIRunner() as any,
    ...overrides,
  };
}

export function createMockPreviewDeps(overrides?: Partial<PreviewDeps>): PreviewDeps {
  return {
    startPreviewServers: vi.fn().mockResolvedValue(null),
    stopPreviewServers: vi.fn(),
    buildPreviewUrl: vi.fn().mockReturnValue(null),
    getPortsForIssue: vi.fn().mockReturnValue(undefined),
    isPreviewRunning: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

export function createMockPolicyDeps(overrides?: Partial<PolicyDeps>): PolicyDeps {
  return {
    shouldAutoApprove: vi.fn().mockReturnValue(false),
    installDependencies: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export function createMockOrchestratorDeps(overrides?: Partial<OrchestratorDeps>): OrchestratorDeps {
  return {
    ...createMockCoreDeps(),
    ...createMockGitDeps(),
    ...createMockAIDeps(),
    ...createMockPreviewDeps(),
    ...createMockPolicyDeps(),
    portAllocator: { allocate: vi.fn(), release: vi.fn(), getPortsForIssue: vi.fn() } as any,
    devServerManager: { start: vi.fn(), stop: vi.fn(), getStatus: vi.fn().mockReturnValue({ running: false }) } as any,
    ...overrides,
  };
}
