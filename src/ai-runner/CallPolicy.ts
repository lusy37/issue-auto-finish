import type { Config } from '../config.js';
import type { AICallPurpose, RunOptions } from './AIRunner.js';

export type { AICallPurpose } from './AIRunner.js';

export type AICallPolicy = Pick<
  RunOptions,
  | 'timeoutMs'
  | 'idleTimeoutMs'
  | 'timeoutGraceMs'
  | 'timeoutExtensionMs'
  | 'timeoutMaxExtensions'
  | 'model'
>;
/** 所有阶段、任务和蒸馏共用配置中的超时与模型策略。 */
export function configuredCallPolicy(ai: Config['ai']): AICallPolicy {
  return {
    timeoutMs: ai.phaseTimeoutMs,
    idleTimeoutMs: ai.idleTimeoutMs,
    timeoutGraceMs: ai.timeoutGraceMs,
    timeoutExtensionMs: ai.timeoutExtensionMs,
    timeoutMaxExtensions: ai.timeoutMaxExtensions,
    model: ai.model,
  };
}

const CALL_MODES: Record<AICallPurpose, { mode: 'plan' | 'agent'; phaseName: string }> = {
  plan: { mode: 'plan', phaseName: 'plan' },
  verify: { mode: 'plan', phaseName: 'verify' },
  'uat-visual-review': { mode: 'plan', phaseName: 'uat-visual-review' },
  'memory-distill': { mode: 'plan', phaseName: 'distill' },
  'rule-distill': { mode: 'plan', phaseName: 'distill' },
  task: { mode: 'agent', phaseName: 'build' },
  'conflict-repair': { mode: 'agent', phaseName: 'build' },
  'integration-repair': { mode: 'agent', phaseName: 'build' },
  'uat-prepare': { mode: 'agent', phaseName: 'build' },
};

/** 计划和蒸馏只返回建议，由服务端验证落盘；构建与检查按各自工作区执行。 */
export function buildCallOptions(policy: AICallPolicy, purpose: AICallPurpose) {
  const mode = CALL_MODES[purpose];
  return {
    ...policy,
    mode: mode.mode,
    phaseName: mode.phaseName,
    purpose,
  };
}
