import type { AIRunner } from './AIRunner.js';
import { ManagedCodexRunner, configureAIConcurrency } from './ManagedCodexRunner.js';

export interface AIConfig {
  maxConcurrency?: number;
  mode: 'codex';
  binary: string;
  phaseTimeoutMs: number;
  model?: string;
}

/** 生产执行器固定为官方 Codex SDK；测试通过 AIRunner 接口直接注入替身。 */
export function createAIRunner(ai: AIConfig): AIRunner {
  if (ai.maxConcurrency !== undefined) configureAIConcurrency(ai.maxConcurrency);
  return new ManagedCodexRunner(ai.binary, ai.model);
}
