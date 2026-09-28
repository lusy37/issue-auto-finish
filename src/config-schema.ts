import { AI_DEFAULTS, PROJECT_DEFAULTS, PREVIEW_DEFAULTS } from './shared/runtime/defaults.js';
/**
 * Zod-based configuration schema and transformation layer.
 *
 * Architecture:
 *   process.env → extractEnvSubset() → envSchema.safeParse() → transformEnvToConfig() → Config
 *
 * The schema is kept flat (keys = env var names) so that validation errors
 * directly reference environment variable names without extra mapping.
 */
import { z } from 'zod';
import { getLocalIP } from './utils/network.js';
import path from 'node:path';
import { getGlobalDir } from './paths.js';

// ---------------------------------------------------------------------------
// Reusable zod helpers
// ---------------------------------------------------------------------------

/** Boolean env var: only `'true'` (case-sensitive) is truthy. */
function envBoolean(defaultValue: string = 'false') {
  return z
    .string()
    .optional()
    .default(defaultValue)
    .transform((v) => v === 'true');
}

/** 用户可编辑的功能开关只接受明确的 true / false。 */
const featureToggle = () =>
  z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true');

/** Integer env var with optional min/max bounds. */
function envInt(defaultValue: string, opts?: { min?: number; max?: number }) {
  let schema = z.coerce.number().int();
  if (opts?.min !== undefined) schema = schema.min(opts.min);
  if (opts?.max !== undefined) schema = schema.max(opts.max);
  return schema.optional().default(Number(defaultValue));
}

/** Port number: integer 1–65535. */
function envPort(defaultValue: string) {
  return z.coerce
    .number()
    .int()
    .min(1, 'Port must be >= 1')
    .max(65535, 'Port must be <= 65535')
    .optional()
    .default(Number(defaultValue));
}

/** Millisecond duration: integer >= 1000. */
function envMs(defaultValue: string) {
  return z.coerce
    .number()
    .int()
    .min(1000, 'Duration must be >= 1000ms')
    .optional()
    .default(Number(defaultValue));
}

// ---------------------------------------------------------------------------
// Flat environment schema
// ---------------------------------------------------------------------------

export const envSchema = z.object({
  // --- Required ---
  GITHUB_API_URL: z
    .string()
    .url('GITHUB_API_URL must be a valid URL')
    .default(PROJECT_DEFAULTS.githubApiUrl),
  GITHUB_TOKEN: z.string().min(1, 'GITHUB_TOKEN is required'),
  GITHUB_REPOSITORY: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/, 'GitHub 仓库必须是 owner/repo 格式'),
  PROJECT_WORK_DIR: z.string().min(1, 'PROJECT_WORK_DIR is required'),

  // --- Paths (override auto-detected data/logs directories) ---
  DATA_DIR: z.string().optional(),
  LOGS_DIR: z.string().optional(),

  // --- Project ---
  GIT_ROOT_DIR: z.string().optional(),
  BASE_BRANCH: z.string().optional().default(PROJECT_DEFAULTS.baseBranch),
  BRANCH_PREFIX: z.string().optional().default('feat/issue'),
  WORKTREE_BASE_DIR: z.string().optional().default(''),
  PROJECT_SUBDIR: z.string().optional().default(''),

  // --- AI ---
  AI_RUNNER_MODE: z.enum(['codex']).optional().default('codex'),
  AI_MODEL: z.string().optional().default(''),
  CODEX_BINARY: z.string().optional(),
  AI_PHASE_TIMEOUT_MS: envMs(String(AI_DEFAULTS.phaseTimeoutMs)),
  AI_IDLE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(0, 'AI_IDLE_TIMEOUT_MS must be >= 0 (0 to disable)')
    .optional()
    .default(1200000),
  PHASE_TIMEOUT_GRACE_MS: envMs('60000'),
  PHASE_TIMEOUT_EXTENSION_MS: envMs('600000'),
  PHASE_TIMEOUT_MAX_EXTENSIONS: z.coerce.number().int().min(0).optional().default(3),

  // --- Pipeline ---
  PIPELINE_MODE: z.string().optional().default('auto'),

  // --- Poll ---
  POLL_DISCOVERY_INTERVAL_MS: envMs('60000'),
  POLL_DRIVE_INTERVAL_MS: envMs('15000'),
  MAX_RETRIES: envInt('3', { min: 0, max: 100 }),
  AI_MAX_CONCURRENCY: envInt(String(AI_DEFAULTS.maxConcurrency), {
    min: 1,
    max: AI_DEFAULTS.maxConcurrencyLimit,
  }),
  MAX_CONCURRENT_ISSUES: envInt(String(PROJECT_DEFAULTS.maxConcurrentIssues), { min: 1 }),

  // --- Review ---
  REVIEW_ENABLED: featureToggle(),
  REVIEW_AUTO_APPROVE_LABELS: z.string().optional().default(''),

  // --- Web ---
  WEB_HOST: z.string().optional().default('127.0.0.1'),
  WEB_PORT: envPort('3000'),
  FRONTEND_DIST_DIR: z.string().optional(),

  // --- Issue Note Sync ---
  ISSUE_NOTE_SYNC_ENABLED: envBoolean('true'),
  WEB_BASE_URL: z.string().optional(),

  // --- E2E ---
  E2E_UI_ENABLED: featureToggle(),
  E2E_BASE_URL: z
    .string()
    .optional()
    .default(`http://127.0.0.1:${PREVIEW_DEFAULTS.frontendPortBase}`),
  E2E_BACKEND_PORT_BASE: envPort(String(PREVIEW_DEFAULTS.backendPortBase)),
  E2E_FRONTEND_PORT_BASE: envPort(String(PREVIEW_DEFAULTS.frontendPortBase)),

  UAT_CONFIG_FILE: z.string().default('playwright.config.ts'),
  UAT_TIMEOUT_MS: envMs('300000'),
  // --- Preview ---
  PREVIEW_STARTUP_TIMEOUT_MS: envMs(String(PREVIEW_DEFAULTS.startupTimeoutMs)),
  PREVIEW_READINESS_INTERVAL_MS: envInt(String(PREVIEW_DEFAULTS.readinessIntervalMs), { min: 10 }),
  PREVIEW_BACKEND_READY_URL: z.string().default(''),
  PREVIEW_FRONTEND_READY_URL: z.string().default(''),
  PREVIEW_ENABLED: envBoolean('true'),
  PREVIEW_HOST: z.string().optional().default('127.0.0.1'),
  PREVIEW_BACKEND_COMMAND: z.string().default('npm run dev:backend'),
  PREVIEW_FRONTEND_COMMAND: z.string().default('npm run dev:frontend -- --port {port}'),
  PREVIEW_FRONTEND_DIR: z.string().default('.'),
  PREVIEW_TTL_MS: envMs(String(24 * 60 * 60 * 1000)),
  PREVIEW_KEEP_AFTER_COMPLETE: envBoolean('false'),
  PREVIEW_REAP_INTERVAL_MS: envMs('300000'),

  // --- Worktree cleanup ---
  // Issue 完成后是否自动清理 worktree（false = 永久保留）。
  WORKTREE_CLEANUP_ENABLED: envBoolean('true'),
  // 完成后保留多久才清理（毫秒），默认 7 天。保留期内可重启预览 / 检查代码 / 修复冲突。
  WORKTREE_RETENTION_MS: envMs(String(7 * 24 * 60 * 60 * 1000)),
  // 清理扫描间隔（毫秒），默认 1 小时。
  WORKTREE_CLEANUP_INTERVAL_MS: envMs('3600000'),

  // --- Locale ---
  LOCALE: z.enum(['zh-CN', 'en']).optional().default('zh-CN'),

  // --- Knowledge ---
  KNOWLEDGE_ENABLED: featureToggle(),
  KNOWLEDGE_PATH: z.string().optional(),

  // --- Distill (知识蒸馏) ---
  DISTILL_ENABLED: featureToggle(),
  DISTILL_MIN_DIARIES_FOR_DISTILL: envInt('3', { min: 1 }),
  DISTILL_MEMORY_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.7),

  // --- Verify-Fix Loop (验证-修复循环) ---
  VERIFY_FIX_LOOP_ENABLED: featureToggle(),
  VERIFY_FIX_MAX_ITERATIONS: envInt('3', { min: 1, max: 10 }),
});

export type ParsedEnv = z.infer<typeof envSchema>;

// ---------------------------------------------------------------------------
// Extract env subset
// ---------------------------------------------------------------------------

/**
 * Picks only the keys declared in `envSchema` from the given env object.
 * Empty strings are converted to `undefined` to preserve the existing
 * "empty = unset" behavior.
 */
export function extractEnvSubset(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (env.WEB_ENABLED) {
    if (env.WEB_ENABLED !== 'true')
      throw new Error('Web 工作台固定开启，请删除 WEB_ENABLED 配置；地址和端口仍可配置。');
    console.warn('WEB_ENABLED 已停用：Web 工作台固定开启，请清理此配置。');
  }
  const keys = Object.keys(envSchema.shape) as (keyof typeof envSchema.shape)[];
  const subset: Record<string, string | undefined> = {};
  for (const key of keys) {
    const val = env[key as string];
    subset[key as string] = val || undefined; // empty string → undefined
  }
  return subset;
}

// ---------------------------------------------------------------------------
// AI Runner helpers
// ---------------------------------------------------------------------------

export type AIRunnerMode = string;

function resolveAIBinary(_mode: AIRunnerMode, env: ParsedEnv): string {
  // 配置层只解析当前执行器字段，不加载 SDK 或执行器实例。
  return env.CODEX_BINARY || '';
}

// ---------------------------------------------------------------------------
// Transform parsed env → nested Config
// ---------------------------------------------------------------------------

export function transformEnvToConfig(env: ParsedEnv, dirname: string) {
  const aiMode = env.AI_RUNNER_MODE;
  const webPort = env.WEB_PORT;

  const gitRootDir = env.GIT_ROOT_DIR ?? env.PROJECT_WORK_DIR;

  return {
    github: {
      apiUrl: env.GITHUB_API_URL,
      token: env.GITHUB_TOKEN,
      repository: env.GITHUB_REPOSITORY,
    },
    project: {
      workDir: env.PROJECT_WORK_DIR,
      gitRootDir,
      baseBranch: env.BASE_BRANCH,
      branchPrefix: env.BRANCH_PREFIX,
      worktreeBaseDir: env.WORKTREE_BASE_DIR || path.join(getGlobalDir(), 'worktrees'),
      projectSubDir: env.PROJECT_SUBDIR,
    },
    ai: {
      maxConcurrency: env.AI_MAX_CONCURRENCY,
      mode: aiMode,
      binary: resolveAIBinary(aiMode, env),
      phaseTimeoutMs: env.AI_PHASE_TIMEOUT_MS,
      idleTimeoutMs: env.AI_IDLE_TIMEOUT_MS || undefined,
      timeoutGraceMs: env.PHASE_TIMEOUT_GRACE_MS,
      timeoutExtensionMs: env.PHASE_TIMEOUT_EXTENSION_MS,
      timeoutMaxExtensions: env.PHASE_TIMEOUT_MAX_EXTENSIONS,
      model: env.AI_MODEL,
    },
    poll: {
      discoveryIntervalMs: env.POLL_DISCOVERY_INTERVAL_MS,
      driveIntervalMs: env.POLL_DRIVE_INTERVAL_MS,
      maxRetries: env.MAX_RETRIES,
      maxConcurrent: env.MAX_CONCURRENT_ISSUES,
    },
    pipeline: {
      mode: env.PIPELINE_MODE,
    },
    review: {
      enabled: env.REVIEW_ENABLED,
      autoApproveLabels: env.REVIEW_AUTO_APPROVE_LABELS.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },
    web: {
      host: env.WEB_HOST,
      port: webPort,
      frontendDistDir:
        env.FRONTEND_DIST_DIR ?? path.resolve(dirname, '..', 'src/web/frontend/dist'),
    },
    issueNoteSync: {
      enabled: env.ISSUE_NOTE_SYNC_ENABLED,
      webBaseUrl: env.WEB_BASE_URL ?? `http://${getLocalIP()}:${webPort}`,
    },
    e2e: {
      enabled: env.E2E_UI_ENABLED,
      configFile: env.UAT_CONFIG_FILE,
      timeoutMs: env.UAT_TIMEOUT_MS,
      baseUrl: env.E2E_BASE_URL,
      backendPortBase: env.E2E_BACKEND_PORT_BASE,
      frontendPortBase: env.E2E_FRONTEND_PORT_BASE,
    },
    preview: {
      enabled: env.PREVIEW_ENABLED,
      startupTimeoutMs: env.PREVIEW_STARTUP_TIMEOUT_MS,
      readinessIntervalMs: env.PREVIEW_READINESS_INTERVAL_MS,
      backendReadyUrl: env.PREVIEW_BACKEND_READY_URL,
      frontendReadyUrl: env.PREVIEW_FRONTEND_READY_URL,
      host: env.PREVIEW_HOST,
      backendCommand: env.PREVIEW_BACKEND_COMMAND,
      frontendCommand: env.PREVIEW_FRONTEND_COMMAND,
      frontendDir: env.PREVIEW_FRONTEND_DIR,
      ttlMs: env.PREVIEW_TTL_MS,
      keepAfterComplete: env.PREVIEW_KEEP_AFTER_COMPLETE,
      reapIntervalMs: env.PREVIEW_REAP_INTERVAL_MS,
    },
    worktree: {
      cleanupEnabled: env.WORKTREE_CLEANUP_ENABLED,
      retentionMs: env.WORKTREE_RETENTION_MS,
      cleanupIntervalMs: env.WORKTREE_CLEANUP_INTERVAL_MS,
    },
    locale: env.LOCALE,
    knowledge: {
      enabled: env.KNOWLEDGE_ENABLED,
      path: env.KNOWLEDGE_PATH,
    },
    distill: {
      enabled: env.DISTILL_ENABLED,
      minDiariesForDistill: env.DISTILL_MIN_DIARIES_FOR_DISTILL,
      memoryConfidenceThreshold: env.DISTILL_MEMORY_CONFIDENCE_THRESHOLD,
    },
    verifyFixLoop: {
      enabled: env.VERIFY_FIX_LOOP_ENABLED,
      maxIterations: env.VERIFY_FIX_MAX_ITERATIONS,
    },
  } as const;
}

// ---------------------------------------------------------------------------
// Config type (derived from transform)
// ---------------------------------------------------------------------------

// We use a widened version so the type is writable and compatible with existing
// code that assigns to Config properties.
type TransformResult = ReturnType<typeof transformEnvToConfig>;

// Deeply writable version of the transform result
type DeepWritable<T> = {
  -readonly [K in keyof T]: T[K] extends object ? DeepWritable<T[K]> : T[K];
};

export type Config = DeepWritable<TransformResult>;

// ---------------------------------------------------------------------------
// Sub-type aliases for interface segregation
// ---------------------------------------------------------------------------

/** GitHub API connection settings. */
export type GitHubConfig = Config['github'];
/** Project / repository settings. */
export type ProjectConfig = Config['project'];
/** AI runner settings. */
export type AIConfig = Config['ai'];
/** Polling intervals and concurrency limits. */
export type PollConfig = Config['poll'];
/** Pipeline mode settings. */
export type PipelineConfig = Config['pipeline'];
/** Review / gate settings. */
export type ReviewConfig = Config['review'];
/** Web dashboard settings. */
export type WebConfig = Config['web'];
/** Issue note-sync settings. */
export type IssueNoteSyncConfig = Config['issueNoteSync'];
/** E2E test settings. */
export type E2eConfig = Config['e2e'];
/** Preview environment settings. */
export type PreviewConfig = Config['preview'];
/** Worktree cleanup settings. */
export type WorktreeConfig = Config['worktree'];
/** Knowledge settings. */
export type KnowledgeConfig = Config['knowledge'];
/** Distill (knowledge distillation) settings. */
export type DistillConfig = Config['distill'];
/** Verify-fix loop settings. */
export type VerifyFixLoopConfig = Config['verifyFixLoop'];

// ---------------------------------------------------------------------------
// ConfigValidationError
// ---------------------------------------------------------------------------

export class ConfigValidationError extends Error {
  public readonly issues: z.ZodIssue[];

  constructor(zodError: z.ZodError) {
    const lines = zodError.issues.map((issue) => {
      const envVar = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  - ${envVar}: ${issue.message}`;
    });
    super(`Configuration validation failed:\n${lines.join('\n')}`);
    this.name = 'ConfigValidationError';
    this.issues = zodError.issues;
  }
}
