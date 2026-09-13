import type { TransitionRule } from './Pipeline.js';


/** 每次执行使用服务启动时的配置，历史次数仍由状态机累计。 */
export function createPlanModeTransitions(maxIterations = 3, maxRetries = 3): readonly TransitionRule[] {
  return Object.freeze([
  // 1. verify-fix loop 最高优先级
  {
    from: '*',
    on: 'requestRetryFrom',
    match: (intent) => intent.kind === 'requestRetryFrom' && intent.targetPhaseId === 'build',
    action: { kind: 'retry-from', targetPhaseId: 'build', maxIterations, resetAttempts: false },
  },
  // 2. 任意阶段 awaitGate
  {
    from: '*',
    on: 'awaitGate',
    action: { kind: 'suspend' },
  },
  // 3. 任意阶段 hard-no-auto 失败
  {
    from: '*',
    on: 'failed',
    match: (intent) => intent.kind === 'failed' && intent.error.retryable === 'hard-no-auto',
    action: { kind: 'fail-pipeline', retryable: 'manual' },
  },
  // 4. 任意阶段 hard 失败
  {
    from: '*',
    on: 'failed',
    match: (intent) => intent.kind === 'failed' && intent.error.retryable === 'hard',
    action: { kind: 'retry-same-phase', maxAttempts: maxRetries + 1 },
  },
  // 5. 任意阶段 soft 失败
  {
    from: '*',
    on: 'failed',
    match: (intent) => intent.kind === 'failed' && intent.error.retryable === 'soft',
    action: { kind: 'retry-same-phase', maxAttempts: maxRetries + 1 },
  },
  // 6. 任意阶段 awaitAsync
  {
    from: '*',
    on: 'awaitAsync',
    action: { kind: 'await-async' },
  },
  // 7. 任意阶段 completed → 默认前进
  {
    from: '*',
    on: 'completed',
    action: { kind: 'advance' },
  },
]);
}

export const PLAN_MODE_TRANSITIONS = createPlanModeTransitions();
