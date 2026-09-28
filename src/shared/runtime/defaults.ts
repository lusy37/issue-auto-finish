/** 仅集中多个入口共享的同义默认值，不合并不同用途的预算。 */
export const AI_DEFAULTS = {
  phaseTimeoutMs: 2_700_000,
  maxConcurrency: 4,
  maxConcurrencyLimit: 32,
} as const;
export const PROJECT_DEFAULTS = {
  githubApiUrl: 'https://api.github.com',
  baseBranch: 'main',
  maxConcurrentIssues: 1,
} as const;
export const PREVIEW_DEFAULTS = {
  backendPortBase: 4000,
  frontendPortBase: 9000,
  maxPorts: 100,
  startupTimeoutMs: 60_000,
  readinessIntervalMs: 200,
} as const;
