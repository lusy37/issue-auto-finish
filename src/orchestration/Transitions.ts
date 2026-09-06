import type { TransitionRule } from './Pipeline.js';


export const PLAN_MODE_TRANSITIONS: readonly TransitionRule[] = Object.freeze([
  // 1. verify-fix loop 最高优先级
  {
    from: 'verify',
    on: 'requestRetryFrom',
    match: (intent) => intent.kind === 'requestRetryFrom' && intent.targetPhaseId === 'build',
    action: { kind: 'retry-from', targetPhaseId: 'build', maxIterations: 3, resetAttempts: false },
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
    action: { kind: 'retry-same-phase', maxAttempts: 3 },
  },
  // 5. 任意阶段 soft 失败
  {
    from: '*',
    on: 'failed',
    match: (intent) => intent.kind === 'failed' && intent.error.retryable === 'soft',
    action: { kind: 'retry-same-phase', maxAttempts: Number.POSITIVE_INFINITY },
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
