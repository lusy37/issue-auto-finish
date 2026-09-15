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
  CompletionDeps,
  PolicyDeps,
  OrchestratorDeps,
} from '../../src/orchestrator/IssueProcessingContext.js';
import { EventBus } from '../../src/events/EventBus.js';

export function createMockGitOperations() {
  return {
    fetch: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    resetOwned: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    fetchAndPull: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    createBranch: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    checkout: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    add: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    commit: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    push: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    branchExists: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
    remoteBranchExists: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
    getCurrentBranch: vi.fn<() => Promise<string>>().mockResolvedValue('master'),
    hasChanges: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
    stash: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stashPop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    addAndCommit: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    addCommitAndPush: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    checkoutTrack: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    worktreeAdd: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    worktreeAddExisting: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    worktreeAddTracking: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    worktreeRemove: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    worktreePrune: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    worktreeList: vi.fn<() => Promise<string[]>>().mockResolvedValue([]),
    deleteBranch: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    deleteRemoteBranch: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    isRebaseInProgress: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
    rebaseAbort: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    showFile: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
    refExists: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  };
}

export function createMockGitHubClient() {
  return {
    listIssues: vi.fn<() => Promise<GitHubIssue[]>>().mockResolvedValue([]),
    listIssuesAdvanced: vi.fn().mockResolvedValue({ issues: [], total: 0 }),
    getIssueDetail: vi.fn<() => Promise<GitHubIssue>>(),
    createIssueNote: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    updateIssueLabels: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    addLabel: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    createPullRequest: vi.fn().mockResolvedValue({
      id: 1, number: 1, title: 'test PR', html_url: 'https://github.example.com/pr/1', state: 'open',
    }),
    createPullRequestNote: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    uploadFile: vi.fn().mockResolvedValue({
      alt: 'screenshot', url: '/uploads/hash/screenshot.png', markdown: '![screenshot](/uploads/hash/screenshot.png)',
    }),
    findPullRequestByBranch: vi.fn().mockResolvedValue(null),
    closePullRequest: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    deleteIssue: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    closeIssue: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    createIssue: vi.fn().mockResolvedValue({
      id: 200, number: 99, title: 'Created Issue', description: 'desc', state: 'open',
      labels: ['auto-finish'], created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
      author: { username: 'testuser', name: 'Test User' },
    }),
    listIssueNotes: vi.fn().mockResolvedValue([]),
    deleteIssueNote: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    cleanupAgentNotes: vi.fn<() => Promise<number>>().mockResolvedValue(0),
    removeLabelsWithPrefix: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getCurrentUser: vi.fn().mockResolvedValue({ id: 1, username: 'bot-user', name: 'Bot User' }),
    setIssueAssignee: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    clearIssueAssignee: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    updateIssueNote: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
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
    run: vi.fn<() => Promise<RunResult>>().mockResolvedValue(defaultResult),
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
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    updateState: vi.fn(),
    clearPhaseHistory: vi.fn(),
    initPhaseProgress: vi.fn(),
    updatePhaseProgress: vi.fn(),
    emitFailure: vi.fn(),
    markFailed: vi.fn(),
    isProcessing: vi.fn().mockReturnValue(false),
    isCompleted: vi.fn().mockReturnValue(false),
    canRetry: vi.fn().mockReturnValue(false),
    getRetryState: vi.fn(),
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

export function createTestConfig(overrides?: Partial<Config>): Config {
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
      mode: 'codex',
      binary: '',
      phaseTimeoutMs: 1800000,
      nvmNodeVersion: '20',
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
      configFile: 'playwright.config.ts',
      enabled: false,
      baseUrl: 'https://localhost:8890',
      backendUrl: 'http://127.0.0.1:3000',
      authCookies: '[]',
      backendPortBase: 14000,
      frontendPortBase: 19000,
      ...overrides?.e2e,
    },
    preview: {
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
      ideSshHost: '',
      ...overrides?.worktree,
    },
    brainstorm: {
      enabled: true,
      maxRefinementRounds: 5,
      timeoutMs: 600000,
      generator: {
        mode: 'codex' as const,
        binary: '',
        nvmNodeVersion: '20',
        model: 'test-codex-model',
      },
      reviewer: {
        mode: 'codex' as const,
        binary: '',
        nvmNodeVersion: '20',
        model: 'test-codex-model',
      },
      ...overrides?.brainstorm,
    },
    chat: {
      enabled: true,
      timeoutMs: 300000,
      maxSessionMessages: 100,
      agent: {
        mode: 'codex' as const,
        binary: '',
        nvmNodeVersion: '20',
        model: 'test-codex-model',
      },
      ...overrides?.chat,
    },
    braindump: {
      enabled: true,
      maxConcurrent: 3,
      splitTimeoutMs: 300000,
      taskTimeoutMs: 1800000,
      maxConflictAttempts: 20,
      createPr: false,
      ...overrides?.braindump,
    },
    autoUpdate: {
      enabled: true,
      intervalMs: 600000,
      registry: 'https://registry.npmjs.org',
      drainTimeoutMs: 300000,
      ...overrides?.autoUpdate,
    },
    iwiki: {
      authCookie: undefined,
      authToken: undefined,
      baseUrl: undefined,
      ...overrides?.iwiki,
    },
    locale: overrides?.locale ?? 'zh-CN',
    knowledge: {
      enabled: true,
      path: overrides?.knowledge?.path,
      ...overrides?.knowledge,
    },
    distill: {
      enabled: true,
      intervalMs: 3600000,
      diarySummarize: true,
      minDiariesForDistill: 3,
      memoryConfidenceThreshold: 0.7,
      vectorEnabled: false,
      ...overrides?.distill,
    },
    coordination: {
      nodeId: undefined,
      ...overrides?.coordination,
    },
    sync: {
      knowledgeToProject: false,
      rulesToProject: false,
      ...overrides?.sync,
    },
    verifyFixLoop: {
      enabled: true,
      maxIterations: 3,
      todolistCheckEnabled: true,
      ...overrides?.verifyFixLoop,
    },
    release: {
      enabled: false,
      detectCacheTtlMs: 604800000,
      ...overrides?.release,
    },
    terminal: {
      enabled: false,
      idleTimeoutMs: 1800000,
      maxSessions: 5,
      ...overrides?.terminal,
    },
    pty: {
      idleDetectMs: 30000,
      defaultAgent: 'codex',
      phaseAgents: {},
      ...overrides?.pty,
    },
  } as Config;
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
    writeProgress: vi.fn(),
    readProgress: vi.fn().mockReturnValue(null),
    writePlan: vi.fn(),
    writeReviewFeedback: vi.fn(),
    readReviewFeedback: vi.fn().mockReturnValue(null),
    readReviewHistory: vi.fn().mockReturnValue([]),
    mergeBackupIfPresent: vi.fn(),
    getAllPlanFiles: vi.fn().mockReturnValue([]),
    createInitialProgress: vi.fn().mockReturnValue({
      displayId: 42, title: 'Test', branchName: 'feat/issue-42',
      currentPhase: 'plan', phases: {},
    }),
    updatePhaseProgress: vi.fn(),
    updatePhaseSessionId: vi.fn(),
    getPhaseSessionId: vi.fn().mockReturnValue(undefined),
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
    tenantId: 'test',
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
    shouldDeployServers: vi.fn().mockReturnValue(false),
    startPreviewServers: vi.fn().mockResolvedValue(null),
    stopPreviewServers: vi.fn(),
    buildPreviewUrl: vi.fn().mockReturnValue(null),
    getPortsForIssue: vi.fn().mockReturnValue(undefined),
    isPreviewRunning: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

export function createMockCompletionDeps(overrides?: Partial<CompletionDeps>): CompletionDeps {
  return {
    screenshotPublisher: { publishScreenshot: vi.fn() } as any,
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
    ...createMockCompletionDeps(),
    ...createMockPolicyDeps(),
    portAllocator: { allocate: vi.fn(), release: vi.fn(), getPortsForIssue: vi.fn() } as any,
    devServerManager: { start: vi.fn(), stop: vi.fn(), getStatus: vi.fn().mockReturnValue({ running: false }) } as any,
    ...overrides,
  };
}
