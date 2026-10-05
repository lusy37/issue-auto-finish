import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  envSchema,
  extractEnvSubset,
  transformEnvToConfig,
  ConfigValidationError,
} from './config-schema.js';
import { getGlobalDir } from './paths.js';

export type {
  Config,
  AIRunnerMode,
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
} from './config-schema.js';
export { ConfigValidationError } from './config-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 读取显式配置或独立配置。 */
export function resolveConfigFilePath(configPath?: string): string {
  return path.resolve(
    configPath ?? process.env.IAF_CONFIG_PATH ?? path.join(getGlobalDir(), '.env'),
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
