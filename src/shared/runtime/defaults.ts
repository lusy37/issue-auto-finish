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
export const E2E_DEFAULTS = {
  browserChannel: 'msedge',
  visualReviewEnabled: true,
  // 0 表示不限制送审图片数量，完整性仍由视觉证据校验保证。
  visualReviewMaxImages: 0,
  visualReviewMaxRetries: 2,
  visualReviewTimeoutMs: 180_000,
} as const;
