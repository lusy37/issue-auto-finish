import type { Config } from '../config.js';
import type { RunOptions } from './AIRunner.js';

export type AICallPolicy = Pick<RunOptions, 'timeoutMs' | 'idleTimeoutMs' | 'timeoutGraceMs' | 'timeoutExtensionMs' | 'timeoutMaxExtensions' | 'model'>;
export type AICallPurpose = 'plan' | 'verify' | 'task' | 'conflict-repair' | 'integration-repair' | 'uat-prepare' | 'memory-distill' | 'rule-distill';

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

/** 计划和蒸馏只返回建议，由服务端验证落盘；构建与检查按各自工作区执行。 */
export function buildCallOptions(policy: AICallPolicy, purpose: AICallPurpose) {
  const readOnly = purpose === 'plan' || purpose === 'memory-distill' || purpose === 'rule-distill';
  const phaseName = purpose === 'plan' || purpose === 'verify' ? purpose : readOnly ? 'distill' : 'build';
  return { ...policy, mode: readOnly ? 'plan' : 'agent', phaseName };
}
