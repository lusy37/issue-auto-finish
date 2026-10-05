import { createTestConfig, createMockGitOperations, createMockGitHubClient, createMockAIRunner as createBaseAIRunner, createTestIssue, type TestConfigOverrides } from './mock-factories.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../../src/config.js';
import type { GitHubIssue } from '../../src/clients/GitHubClient.js';
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

// 集成场景仅覆盖基础执行器的默认结果。
function createMockAIRunner() {
  const runner = createBaseAIRunner();
  runner.run.mockResolvedValue({
    success: true,
    output: 'AI completed successfully.',
    sessionId: 'test-session-id',
    exitCode: 0,
  });
  return runner;
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
  return createTestIssue({
    title: '集成测试 Issue',
    description: '用于集成测试的 Issue 描述',
    ...overrides,
  });
}
