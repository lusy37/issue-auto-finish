import path from 'node:path';
import { getGlobalDir } from '../../src/paths.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset modules so loadConfig re-reads env
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function loadConfigFresh() {
    // Dynamic import so each test gets a fresh module
    const mod = await import('../../src/config.js');
    return mod;
  }

  /** Set the minimum required env vars for a valid config. */
  function setRequiredEnv() {
    process.env.GITHUB_API_URL = 'https://example.com';
    process.env.GITHUB_TOKEN = 'token';
    process.env.GITHUB_REPOSITORY = 'test/project';
    process.env.PROJECT_WORK_DIR = '/tmp/test';
  }

  // -----------------------------------------------------------------------
  // 基础配置读取与校验
  // -----------------------------------------------------------------------

  it('loadConfig includes worktreeBaseDir field', async () => {
    setRequiredEnv();

    const { loadConfig } = await loadConfigFresh();
    const config = loadConfig();

    expect(config.project).toHaveProperty('worktreeBaseDir');
    expect(typeof config.project.worktreeBaseDir).toBe('string');
  });

  it('loadConfig includes projectSubDir field', async () => {
    setRequiredEnv();

    const { loadConfig } = await loadConfigFresh();
    const config = loadConfig();

    expect(config.project).toHaveProperty('projectSubDir');
    expect(typeof config.project.projectSubDir).toBe('string');
  });

  it('worktreeBaseDir defaults to .iaf-mini/worktrees', async () => {
    setRequiredEnv();
    // Ensure WORKTREE_BASE_DIR is not set
    delete process.env.WORKTREE_BASE_DIR;

    const { loadConfig } = await loadConfigFresh();
    const config = loadConfig();

    expect(config.project.worktreeBaseDir).toBe(path.join(getGlobalDir(), 'worktrees'));
  });

  it('loadConfig includes ai.mode and ai.binary', async () => {
    setRequiredEnv();
    // Set empty to prevent dotenv from overriding with .env values;
    // extractEnvSubset treats empty string as falsy and returns undefined
    process.env.AI_RUNNER_MODE = '';
    process.env.CODEX_BINARY = '';

    const { loadConfig } = await loadConfigFresh();
    const config = loadConfig();

    expect(config.ai).toBeDefined();
    expect(config.ai.mode).toBe('codex');
    expect(config.ai.binary).toBe('');
  });

  // -----------------------------------------------------------------------
  // New zod validation tests
  // -----------------------------------------------------------------------

  describe('validation errors', () => {
    it('reports all missing required variables at once', async () => {
      // Clear all required vars
      delete process.env.GITHUB_API_URL;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_REPOSITORY;
      delete process.env.PROJECT_WORK_DIR;
      // Prevent dotenv from loading .env file
      process.env.IAF_CONFIG_PATH = '/nonexistent/.env';

      const { loadConfig, ConfigValidationError } = await loadConfigFresh();

      expect(() => loadConfig()).toThrow(ConfigValidationError);
      try {
        loadConfig();
      } catch (err) {
        const validationErr = err as InstanceType<typeof ConfigValidationError>;
        expect(validationErr.issues.length).toBeGreaterThanOrEqual(3);
        const paths = validationErr.issues.map((i) => i.path[0]);
        expect(paths).toContain('GITHUB_TOKEN');
        expect(paths).toContain('GITHUB_REPOSITORY');
        expect(paths).toContain('PROJECT_WORK_DIR');
      }
    });

    it('rejects invalid URL for GITHUB_API_URL', async () => {
      process.env.GITHUB_API_URL = 'not-a-url';
      process.env.GITHUB_TOKEN = 'token';
      process.env.GITHUB_REPOSITORY = 'test/project';
      process.env.PROJECT_WORK_DIR = '/tmp/test';

      const { loadConfig, ConfigValidationError } = await loadConfigFresh();

      expect(() => loadConfig()).toThrow(ConfigValidationError);
      try {
        loadConfig();
      } catch (err) {
        const validationErr = err as InstanceType<typeof ConfigValidationError>;
        const urlIssue = validationErr.issues.find(
          (i) => i.path[0] === 'GITHUB_API_URL',
        );
        expect(urlIssue).toBeDefined();
      }
    });

    it('rejects out-of-range port for WEB_PORT', async () => {
      setRequiredEnv();
      process.env.WEB_PORT = '99999';

      const { loadConfig, ConfigValidationError } = await loadConfigFresh();

      expect(() => loadConfig()).toThrow(ConfigValidationError);
      try {
        loadConfig();
      } catch (err) {
        const validationErr = err as InstanceType<typeof ConfigValidationError>;
        const portIssue = validationErr.issues.find(
          (i) => i.path[0] === 'WEB_PORT',
        );
        expect(portIssue).toBeDefined();
      }
    });

    it('rejects non-numeric value for numeric field', async () => {
      setRequiredEnv();
      process.env.WEB_PORT = 'abc';

      const { loadConfig, ConfigValidationError } = await loadConfigFresh();

      expect(() => loadConfig()).toThrow(ConfigValidationError);
    });

    it('拒绝未支持的流水线配置', async () => {
      setRequiredEnv();
      process.env.PIPELINE_MODE = 'custom-mode';

      const { loadConfig, ConfigValidationError } = await loadConfigFresh();
      expect(() => loadConfig()).toThrow(ConfigValidationError);
    });

    it('拒绝未支持的执行器配置', async () => {
      setRequiredEnv();
      process.env.AI_RUNNER_MODE = 'nonexistent-runner';

      const { loadConfig } = await loadConfigFresh();

      expect(() => loadConfig()).toThrow();
    });

    it('ConfigValidationError is an instance of Error', async () => {
      // Prevent dotenv from loading .env file
      process.env.IAF_CONFIG_PATH = '/nonexistent/.env';
      delete process.env.GITHUB_API_URL;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_REPOSITORY;
      delete process.env.PROJECT_WORK_DIR;

      const { loadConfig, ConfigValidationError } = await loadConfigFresh();

      try {
        loadConfig();
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(ConfigValidationError);
        expect((err as InstanceType<typeof ConfigValidationError>).name).toBe('ConfigValidationError');
      }
    });
  });

  describe('defaults', () => {
    it('applies correct default values', async () => {
      setRequiredEnv();
      // Override optional vars with empty string to get defaults
      // (empty string → undefined in extractEnvSubset)
      process.env.AI_RUNNER_MODE = '';
      process.env.PIPELINE_MODE = '';
      process.env.LOCALE = '';
      process.env.MAX_RETRIES = '';
      process.env.MAX_CONCURRENT_ISSUES = '';
      process.env.WEB_PORT = '';
      process.env.WEBHOOK_PORT = '';

      const { loadConfig } = await loadConfigFresh();
      const config = loadConfig();

      expect(config.ai.mode).toBe('codex');
      expect(config.pipeline.mode).toBe('auto');
      expect(config.locale).toBe('zh-CN');
      expect(config.poll.maxRetries).toBe(3);
      expect(config.poll.maxConcurrent).toBe(1);
      expect(config.web.port).toBe(3000);
    });

    it('GIT_ROOT_DIR defaults to PROJECT_WORK_DIR', async () => {
      setRequiredEnv();
      process.env.GIT_ROOT_DIR = '';

      const { loadConfig } = await loadConfigFresh();
      const config = loadConfig();

      expect(config.project.gitRootDir).toBe('/tmp/test');
    });

    it('GIT_ROOT_DIR can be overridden', async () => {
      setRequiredEnv();
      process.env.GIT_ROOT_DIR = '/custom/git/root';

      const { loadConfig } = await loadConfigFresh();
      const config = loadConfig();

      expect(config.project.gitRootDir).toBe('/custom/git/root');
    });
  });

  describe('complete config structure', () => {
    it('all top-level sections are present', async () => {
      setRequiredEnv();

      const { loadConfig } = await loadConfigFresh();
      const config = loadConfig();

      expect(config).toHaveProperty('github');
      expect(config).toHaveProperty('project');
      expect(config).toHaveProperty('ai');
      expect(config).toHaveProperty('poll');
      expect(config).toHaveProperty('pipeline');
      expect(config).toHaveProperty('review');
      expect(config).toHaveProperty('web');
      expect(config).toHaveProperty('issueNoteSync');
      expect(config).toHaveProperty('e2e');
      expect(config).toHaveProperty('preview');
      expect(config).toHaveProperty('locale');
    });
  });
});
