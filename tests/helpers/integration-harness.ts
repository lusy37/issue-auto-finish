import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import type { Config } from '../../src/config.js';
import type { GitHubIssue } from '../../src/clients/GitHubClient.js';
import type { RunResult } from '../../src/ai-runner/index.js';
import { IssueTracker } from '../../src/tracker/IssueTracker.js';
import {
  PLAN_MODE_PIPELINE,
  createLifecycleManager,
} from '../../src/pipeline/PipelineDefinition.js';
import { ActionLifecycleManager } from '../../src/lifecycle/ActionLifecycleManager.js';


// ── Mock type aliases ──

export type MockGitHubClient = ReturnType<typeof createMockGitHubClient>;
export type MockAIRunner = ReturnType<typeof createMockAIRunner>;
export type MockGitOperations = ReturnType<typeof createMockGitOperations>;

// ── Integration harness ──

export interface IntegrationHarness {
  dataDir: string;
  tracker: IssueTracker;
  github: MockGitHubClient;
  aiRunner: MockAIRunner;
  git: MockGitOperations;
  config: Config;
  cleanup: () => void;
}

/**
 * 创建一个集成测试的 harness。
 *
 * - 使用临时目录作为数据目录，afterEach 时清理
 * - 使用真实的 IssueTracker（文件持久化）
 * - Mock 外部服务（GitHubClient、AIRunner、GitOperations）
 */
export function createHarness(configOverrides?: Partial<Config>): IntegrationHarness {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'iaf-test-'));

  const config = createIntegrationTestConfig(dataDir, configOverrides);
  const github = createMockGitHubClient();
  const aiRunner = createMockAIRunner();
  const git = createMockGitOperations();

  // Create real lifecycle managers for tracker
  const lifecycleManagers = new Map<string, ActionLifecycleManager>();
  lifecycleManagers.set('plan-mode', createLifecycleManager(PLAN_MODE_PIPELINE));

  const tracker = new IssueTracker(dataDir, lifecycleManagers);

  return {
    dataDir,
    tracker,
    github,
    aiRunner,
    git,
    config,
    cleanup: () => {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    },
  };
}

// ── Mock factories (integration-specific, more complete than unit mocks) ──

function createMockGitOperations() {
  return {
    fetch: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    fetchAndPull: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    createBranch: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    checkout: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    add: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    commit: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    push: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    forcePush: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
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
    worktreeList: vi.fn<() => Promise<string[]>>().mockResolvedValue([]),
    worktreePrune: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    deleteBranch: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    deleteRemoteBranch: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    showFile: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
    isRebaseInProgress: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
    rebaseAbort: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    refExists: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  };
}

function createMockGitHubClient() {
  return {
    listIssues: vi.fn<() => Promise<GitHubIssue[]>>().mockResolvedValue([]),
    listIssuesAdvanced: vi.fn().mockResolvedValue({ issues: [], total: 0 }),
    getIssueDetail: vi.fn<() => Promise<GitHubIssue>>(),
    createIssueNote: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    updateIssueLabels: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    addLabel: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    createPullRequest: vi.fn().mockResolvedValue({
      id: 1, number: 1, title: 'test PR',
      html_url: 'https://github.example.com/pr/1', state: 'open',
    }),
    createPullRequestNote: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    uploadFile: vi.fn().mockResolvedValue({
      alt: 'screenshot', url: '/uploads/hash/screenshot.png',
      markdown: '![screenshot](/uploads/hash/screenshot.png)',
    }),
    findPullRequestByBranch: vi.fn().mockResolvedValue(null),
    closePullRequest: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    deleteIssue: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    closeIssue: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    createIssue: vi.fn().mockResolvedValue({
      id: 200, number: 99, title: 'Created Issue', description: 'desc',
      state: 'open', labels: ['auto-finish'],
      created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
      author: { username: 'testuser', name: 'Test User' },
    }),
    listIssueNotes: vi.fn().mockResolvedValue([]),
    deleteIssueNote: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    cleanupAgentNotes: vi.fn<() => Promise<number>>().mockResolvedValue(0),
    getCurrentUser: vi.fn().mockResolvedValue({ id: 1, username: 'bot-user', name: 'Bot User' }),
    setIssueAssignee: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    clearIssueAssignee: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

function createMockAIRunner() {
  const defaultResult: RunResult = {
    success: true,
    output: 'AI completed successfully.',
    sessionId: 'test-session-id',
    exitCode: 0,
  };
  return {
    run: vi.fn<() => Promise<RunResult>>().mockResolvedValue(defaultResult),
    killAll: vi.fn(),
    killByWorkDir: vi.fn().mockReturnValue(0),
  };
}

// ── Config factory ──

function createIntegrationTestConfig(dataDir: string, overrides?: Partial<Config>): Config {
  const gitRootDir = path.join(dataDir, 'gitroot');
  const repository = 'test/project';
  const baseBranch = 'master';
  const branchPrefix = 'feat/issue';
  const projectSubDir = 'app/test-project';

  return {
    github: {
      apiUrl: 'https://github.example.com',
      token: 'test-token',
      repository,
      ...overrides?.github,
    },
    project: {
      workDir: path.join(dataDir, 'workdir'),
      gitRootDir,
      baseBranch,
      branchPrefix,
      worktreeBaseDir: path.join(dataDir, 'worktrees'),
      projectSubDir,
      ...overrides?.project,
    },
    ai: {
      mode: 'codex',
      binary: 'codex',
      phaseTimeoutMs: 5000, // short timeout for tests
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
      mode: 'plan-mode',
      ...overrides?.pipeline,
    },
    review: {
      enabled: true,
      autoApproveLabels: [],
      ...overrides?.review,
    },
    web: {
      enabled: false,
      host: '0.0.0.0',
      port: 3000,
      frontendDistDir: path.join(dataDir, 'dist'),
      ...overrides?.web,
    },
    issueNoteSync: {
      enabled: false,
      webBaseUrl: 'http://localhost:3000',
      ...overrides?.issueNoteSync,
    },
    e2e: {
      enabled: false,
      baseUrl: 'https://localhost:8890',
      backendUrl: 'http://127.0.0.1:3000',
      authCookies: '[]',
      backendPortBase: 14000,
      frontendPortBase: 19000,
      uatVendorDir: '',
      uatConfigFile: '',
      pythonBin: 'python3',
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
        binary: 'codex',
        nvmNodeVersion: '20',
        model: 'test-codex-model',
      },
      reviewer: {
        mode: 'codex' as const,
        binary: 'codex',
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
        binary: 'codex',
        nvmNodeVersion: '20',
        model: 'test-codex-model',
      },
      ...overrides?.chat,
    },
    braindump: {
      enabled: true,
      maxConcurrent: 3,
      splitTimeoutMs: 5000,
      taskTimeoutMs: 5000,
      maxConflictAttempts: 20,
      createPr: false,
      ...overrides?.braindump,
    },
    autoUpdate: {
      enabled: false,
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
      enabled: false,
      path: undefined,
      ...overrides?.knowledge,
    },
    distill: {
      enabled: false,
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
  } as Config;
}

// ── Scripted harness ──

export interface ScriptedHarness extends Omit<IntegrationHarness, 'aiRunner'> {
  aiRunner: import('./scripted-ai-runner.js').ScriptedAIRunner;
}

/**
 * 创建使用 ScriptedAIRunner 的集成测试 harness。
 * 与 createHarness 类似，但 aiRunner 是 ScriptedAIRunner 而非 vi.fn() mock。
 */
export function createScriptedHarness(
  scripts: import('./scripted-ai-runner.js').AICallScript[],
  configOverrides?: Partial<Config>,
): ScriptedHarness {
  // Lazy import to avoid circular dependency
  const { ScriptedAIRunner } = require('./scripted-ai-runner.js') as typeof import('./scripted-ai-runner.js');

  const dataDir = mkdtempSync(path.join(tmpdir(), 'iaf-scripted-'));
  const config = createIntegrationTestConfig(dataDir, configOverrides);
  const github = createMockGitHubClient();
  const aiRunner = new ScriptedAIRunner(scripts);
  const git = createMockGitOperations();

  const lifecycleManagers = new Map<string, ActionLifecycleManager>();
  lifecycleManagers.set('plan-mode', createLifecycleManager(PLAN_MODE_PIPELINE));

  const tracker = new IssueTracker(dataDir, lifecycleManagers);

  return {
    dataDir,
    tracker,
    github,
    aiRunner,
    git,
    config,
    cleanup: () => {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    },
  };
}

// ── Test issue factory ──

export function createIntegrationTestIssue(overrides?: Partial<GitHubIssue>): GitHubIssue {
  return {
    id: 100,
    number: 42,
    title: '集成测试 Issue',
    description: '用于集成测试的 Issue 描述',
    state: 'open',
    labels: ['auto-finish'],
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    author: { username: 'testuser', name: 'Test User' },
    ...overrides,
  };
}
