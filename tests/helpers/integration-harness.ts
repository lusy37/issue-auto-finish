import type { GitOperations } from '../../src/git/GitOperations.js';
import type { GitHubClient } from '../../src/clients/GitHubClient.js';
import type { RunOptions } from '../../src/ai-runner/AIRunner.js';
import { createTestConfig, type TestConfigOverrides } from './mock-factories.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import type { Config } from '../../src/config.js';
import type { GitHubIssue } from '../../src/clients/GitHubClient.js';
import type { RunResult } from '../../src/ai-runner/index.js';
import { IssueTracker } from '../../src/tracker/IssueTracker.js';
import { PLAN_MODE_PIPELINE } from '../../src/pipeline/PipelineMetadata.js';


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
export function createHarness(configOverrides?: TestConfigOverrides): IntegrationHarness {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'iaf-test-'));

  const config = createIntegrationTestConfig(dataDir, configOverrides);
  const github = createMockGitHubClient();
  const aiRunner = createMockAIRunner();
  const git = createMockGitOperations();

  const tracker = new IssueTracker(dataDir, PLAN_MODE_PIPELINE);

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
    fetch: vi.fn<(...args: Parameters<GitOperations['fetch']>) => Promise<void>>().mockResolvedValue(undefined),
    fetchAndPull: vi.fn<(...args: Parameters<GitOperations['fetchAndPull']>) => Promise<void>>().mockResolvedValue(undefined),
    createBranch: vi.fn<(...args: Parameters<GitOperations['createBranch']>) => Promise<void>>().mockResolvedValue(undefined),
    checkout: vi.fn<(...args: Parameters<GitOperations['checkout']>) => Promise<void>>().mockResolvedValue(undefined),
    add: vi.fn<(...args: Parameters<GitOperations['add']>) => Promise<void>>().mockResolvedValue(undefined),
    commit: vi.fn<(...args: Parameters<GitOperations['commit']>) => Promise<void>>().mockResolvedValue(undefined),
    push: vi.fn<(...args: Parameters<GitOperations['push']>) => Promise<void>>().mockResolvedValue(undefined),
    forcePush: vi.fn<(...args: Parameters<GitOperations['forcePush']>) => Promise<void>>().mockResolvedValue(undefined),
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
    worktreeList: vi.fn<(...args: Parameters<GitOperations['worktreeList']>) => Promise<string[]>>().mockResolvedValue([]),
    worktreePrune: vi.fn<(...args: Parameters<GitOperations['worktreePrune']>) => Promise<void>>().mockResolvedValue(undefined),
    deleteBranch: vi.fn<(...args: Parameters<GitOperations['deleteBranch']>) => Promise<void>>().mockResolvedValue(undefined),
    deleteRemoteBranch: vi.fn<(...args: Parameters<GitOperations['deleteRemoteBranch']>) => Promise<void>>().mockResolvedValue(undefined),
    showFile: vi.fn<(...args: Parameters<GitOperations['showFile']>) => Promise<string | null>>().mockResolvedValue(null),
    isRebaseInProgress: vi.fn<(...args: Parameters<GitOperations['isRebaseInProgress']>) => Promise<boolean>>().mockResolvedValue(false),
    rebaseAbort: vi.fn<(...args: Parameters<GitOperations['rebaseAbort']>) => Promise<void>>().mockResolvedValue(undefined),
    refExists: vi.fn<(...args: Parameters<GitOperations['refExists']>) => Promise<boolean>>().mockResolvedValue(true),
  };
}

function createMockGitHubClient() {
  return {
    listIssues: vi.fn<(...args: Parameters<GitHubClient['listIssues']>) => Promise<GitHubIssue[]>>().mockResolvedValue([]),
    listIssuesAdvanced: vi.fn().mockResolvedValue({ issues: [], total: 0 }),
    getIssueDetail: vi.fn<(...args: Parameters<GitHubClient['getIssueDetail']>) => Promise<GitHubIssue>>(),
    createIssueNote: vi.fn<(...args: Parameters<GitHubClient['createIssueNote']>) => Promise<void>>().mockResolvedValue(undefined),
    updateIssueLabels: vi.fn<(...args: Parameters<GitHubClient['updateIssueLabels']>) => Promise<void>>().mockResolvedValue(undefined),
    addLabel: vi.fn<(...args: Parameters<GitHubClient['addLabel']>) => Promise<void>>().mockResolvedValue(undefined),
    createPullRequest: vi.fn().mockResolvedValue({
      id: 1, number: 1, title: 'test PR',
      html_url: 'https://github.example.com/pr/1', state: 'open',
    }),
    createPullRequestNote: vi.fn<(...args: Parameters<GitHubClient['createPullRequestNote']>) => Promise<void>>().mockResolvedValue(undefined),
    uploadFile: vi.fn().mockResolvedValue({
      alt: 'screenshot', url: '/uploads/hash/screenshot.png',
      markdown: '![screenshot](/uploads/hash/screenshot.png)',
    }),
    findPullRequestByBranch: vi.fn().mockResolvedValue(null),
    closePullRequest: vi.fn<(...args: Parameters<GitHubClient['closePullRequest']>) => Promise<void>>().mockResolvedValue(undefined),
    deleteIssue: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    closeIssue: vi.fn<(...args: Parameters<GitHubClient['closeIssue']>) => Promise<void>>().mockResolvedValue(undefined),
    createIssue: vi.fn().mockResolvedValue({
      id: 200, number: 99, title: 'Created Issue', description: 'desc',
      state: 'open', labels: ['auto-finish'],
      created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
      author: { username: 'testuser', name: 'Test User' },
    }),
    listIssueNotes: vi.fn().mockResolvedValue([]),
    deleteIssueNote: vi.fn<(...args: Parameters<GitHubClient['deleteIssueNote']>) => Promise<void>>().mockResolvedValue(undefined),
    cleanupAgentNotes: vi.fn<(...args: Parameters<GitHubClient['cleanupAgentNotes']>) => Promise<number>>().mockResolvedValue(0),
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
    run: vi.fn<(options: RunOptions) => Promise<RunResult>>().mockResolvedValue(defaultResult),
    killAll: vi.fn(),
    killByWorkDir: vi.fn().mockReturnValue(0),
  };
}

// ── Config factory ──

function createIntegrationTestConfig(dataDir: string, overrides?: TestConfigOverrides): Config {
  return createTestConfig({
    ...overrides,
    project: { workDir: path.join(dataDir, 'workdir'), gitRootDir: path.join(dataDir, 'gitroot'), worktreeBaseDir: path.join(dataDir, 'worktrees'), projectSubDir: 'app/test-project', ...overrides?.project },
    ai: { phaseTimeoutMs: 5000, ...overrides?.ai },
    pipeline: { mode: 'plan-mode', ...overrides?.pipeline },
    web: { frontendDistDir: path.join(dataDir, 'dist'), ...overrides?.web },
    issueNoteSync: { enabled: false, ...overrides?.issueNoteSync },
    knowledge: { enabled: false, ...overrides?.knowledge },
    distill: { enabled: false, ...overrides?.distill },
  });
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
  configOverrides?: TestConfigOverrides,
): ScriptedHarness {
  // Lazy import to avoid circular dependency
  const { ScriptedAIRunner } = require('./scripted-ai-runner.js') as typeof import('./scripted-ai-runner.js');

  const dataDir = mkdtempSync(path.join(tmpdir(), 'iaf-scripted-'));
  const config = createIntegrationTestConfig(dataDir, configOverrides);
  const github = createMockGitHubClient();
  const aiRunner = new ScriptedAIRunner(scripts);
  const git = createMockGitOperations();

  const tracker = new IssueTracker(dataDir, PLAN_MODE_PIPELINE);

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
