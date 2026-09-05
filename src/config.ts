import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  envSchema,
  extractEnvSubset,
  transformEnvToConfig,
  ConfigValidationError,
} from "./config-schema.js";
import { getGlobalDir } from "./paths.js";

export type {
  Config,
  AIRunnerMode,
  // Sub-type aliases for interface segregation
  GitHubConfig,
  ProjectConfig,
  AIConfig,
  PollConfig,
  PipelineConfig,
  ReviewConfig,
  WebConfig,
  IssueNoteSyncConfig,
  E2eConfig,
  PreviewConfig,
  KnowledgeConfig,
  DistillConfig,
} from "./config-schema.js";
export { ConfigValidationError } from "./config-schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 只读取显式配置或面试版独立配置，不探测旧目录。 */
export function resolveConfigFilePath(configPath?: string): string {
  return path.resolve(
    configPath ??
      process.env.IAF_CONFIG_PATH ??
      path.join(getGlobalDir(), ".env"),
  );
}

let _dotenvLoaded = false;
function ensureDotenvLoaded(): void {
  if (_dotenvLoaded) return;
  _dotenvLoaded = true;
  loadDotenv({ path: resolveConfigFilePath() });
}

export function loadConfig() {
  ensureDotenvLoaded();

  const subset = extractEnvSubset(process.env);
  const result = envSchema.safeParse(subset);

  if (!result.success) {
    throw new ConfigValidationError(result.error);
  }

  return transformEnvToConfig(result.data, __dirname);
}

/**
 * Reset dotenv cache so the next loadConfig() re-reads the .env file.
 */
export function resetDotenvCache(): void {
  _dotenvLoaded = false;
}

/**
 * Reload config from .env file.
 * Clears dotenv cache, removes stale IAF env vars from process.env,
 * then re-reads and re-parses everything.
 */
export function reloadConfig() {
  resetDotenvCache();
  // Clear process.env of IAF-related keys so dotenv can overwrite them
  const iafKeys = extractEnvSubset(process.env);
  for (const key of Object.keys(iafKeys)) {
    delete process.env[key];
  }
  return loadConfig();
}
