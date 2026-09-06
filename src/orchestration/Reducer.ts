import type { PhaseIntent, PhaseError, GateReason, RequestRetryFromIntent } from './Intent.js';
import type {
  OrchestrationState,
  PhaseHistoryEntry,
  PhaseHistoryOutcome,
  RetryFromContext,
  GateAction,
} from './OrchestrationState.js';
import type { Pipeline, TransitionRule } from './Pipeline.js';
import {
  findPhaseIndex,
  findPhaseSpec,
  isLastPhase,
  nextPhaseId,
} from './Pipeline.js';

/**
 * Reducer — 编排状态机的纯函数核心。
 *
 * 设计原则：
 * - 完全纯函数：无副作用、无 I/O、无 tracker / git / eventBus 依赖。
 * - 输入：当前状态 + Intent + Pipeline + history + counters。
 * - 输出：下一状态 + 下一计数 + 历史条目 + 副作用清单。
 * - 副作用通过 ReducerSideEffect[] 表达，由 Orchestrator 按序执行。
 */

// ---------------------------------------------------------------------------
// Reducer I/O
// ---------------------------------------------------------------------------

export interface ReducerInput {
  readonly state: OrchestrationState;
  readonly intent: PhaseIntent;
  readonly pipeline: Pipeline;
  readonly history: readonly PhaseHistoryEntry[];
  /** 当前阶段的 attempts（自动重试计数） */
  readonly attempts: number;
  /** 阶段开始时间（用于 PhaseHistoryEntry.startedAt） */
  readonly startedAt: string;
  /** 当前时间（用于 PhaseHistoryEntry.endedAt） */
  readonly now: string;
}

export interface ReducerOutput {
  readonly nextState: OrchestrationState;
  /** 处理后的 attempts（重试计数） */
  readonly nextAttempts: number;
  /** 应当追加到 phaseHistory 的条目 */
  readonly historyEntry: PhaseHistoryEntry;
  /** 编排器需要按序执行的副作用 */
  readonly sideEffects: readonly ReducerSideEffect[];
}

/**
 * 副作用描述 — 编排器消费此清单驱动外部组件。
 *
 * Reducer 不直接调 tracker / eventBus / git，而是返回此结构，
 * 由 Orchestrator 翻译为具体调用。这样保证 Reducer 的纯函数性。
 */
export type ReducerSideEffect =
  | { readonly kind: 'commit-artifacts'; readonly phaseId: string }
  | { readonly kind: 'sync-result-to-issue'; readonly phaseId: string }
  | { readonly kind: 'emit-event'; readonly type: string; readonly payload: Record<string, unknown> }
  | { readonly kind: 'comment-progress'; readonly phaseId: string; readonly message: string }
  | { readonly kind: 'await-async'; readonly awaiter: Promise<PhaseIntent>; readonly phaseId: string };

// ---------------------------------------------------------------------------
// applyIntent — 主入口
// ---------------------------------------------------------------------------

/**
 * 处理阶段返回的 Intent，计算下一状态。
 *
 * 前置条件：state.kind === 'running'（必须有正在执行的阶段才能产生 Intent）。
 */
export function applyIntent(input: ReducerInput): ReducerOutput {
  const { state, intent, pipeline } = input;
  if (state.kind !== 'running') {
    throw new Error(
      `applyIntent requires state.kind === 'running', got '${state.kind}'`,
    );
  }

  const phaseId = state.phaseId;
  const phaseSpec = findPhaseSpec(pipeline, phaseId);
  if (!phaseSpec) {
    throw new Error(`Phase '${phaseId}' not found in pipeline '${pipeline.id}'`);
  }

  // 路由到具体处理器
  switch (intent.kind) {
    case 'completed':
      return reduceCompleted(input, phaseId);
    case 'failed':
      return reduceFailed(input, phaseId);
    case 'awaitGate':
      return reduceAwaitGate(input, phaseId);
    case 'awaitAsync':
      return reduceAwaitAsync(input, phaseId);
    case 'requestRetryFrom':
      return reduceRequestRetryFrom(input, phaseId);
  }
}

// ---------------------------------------------------------------------------
// 各 Intent 类型的处理器
// ---------------------------------------------------------------------------

function reduceCompleted(input: ReducerInput, phaseId: string): ReducerOutput {
  const { intent, pipeline, history, startedAt, now } = input;
  if (intent.kind !== 'completed') throw new Error('reduceCompleted requires completed intent');

  const rule = findTransition(pipeline.transitions, phaseId, 'completed', intent);
  const action = rule?.action ?? { kind: 'advance' };

  const historyEntry: PhaseHistoryEntry = {
    phaseId,
    attemptId: countAttempts(history, phaseId) + 1,
    startedAt,
    endedAt: now,
    outcome: 'completed',
    sessionId: intent.sessionId,
  };

  const sideEffects: ReducerSideEffect[] = [
    { kind: 'commit-artifacts', phaseId },
    { kind: 'sync-result-to-issue', phaseId },
  ];

  if (action.kind === 'advance') {
    if (isLastPhase(pipeline, phaseId)) {
      return {
        nextState: { kind: 'pipeline-completed' },
        nextAttempts: 0,
        historyEntry,
        sideEffects: [
          ...sideEffects,
          { kind: 'emit-event', type: 'pipeline:completed', payload: {} },
        ],
      };
    }
    const next = nextPhaseId(pipeline, phaseId)!;
    return {
      nextState: { kind: 'running', phaseId: next },
      nextAttempts: 0,
      historyEntry,
      sideEffects,
    };
  }

  // 其他 action（理论上不会发生于 completed）
  throw new Error(`Unexpected transition action for completed: ${action.kind}`);
}

function reduceFailed(input: ReducerInput, phaseId: string): ReducerOutput {
  const { intent, pipeline, history, attempts, startedAt, now } = input;
  if (intent.kind !== 'failed') throw new Error('reduceFailed requires failed intent');

  const rule = findTransition(pipeline.transitions, phaseId, 'failed', intent);
  const action = rule?.action ?? { kind: 'fail-pipeline', retryable: 'manual' };

  const historyEntry: PhaseHistoryEntry = {
    phaseId,
    attemptId: countAttempts(history, phaseId) + 1,
    startedAt,
    endedAt: now,
    outcome: 'failed',
    sessionId: intent.sessionId,
    errorMessage: intent.error.message,
  };

  const sideEffects: ReducerSideEffect[] = [
    {
      kind: 'emit-event',
      type: 'phase:failed',
      payload: { phaseId, error: intent.error.message, retryable: intent.error.retryable },
    },
  ];

  if (action.kind === 'retry-same-phase') {
    const newAttempts = intent.error.retryable === 'soft' ? attempts : attempts + 1;
    if (newAttempts >= action.maxAttempts) {
      return {
        nextState: {
          kind: 'pipeline-failed',
          failedAt: phaseId,
          retryable: 'manual',
          error: intent.error,
        },
        nextAttempts: newAttempts,
        historyEntry,
        sideEffects,
      };
    }
    return {
      nextState: { kind: 'running', phaseId },
      nextAttempts: newAttempts,
      historyEntry,
      sideEffects,
    };
  }

  if (action.kind === 'fail-pipeline') {
    return {
      nextState: {
        kind: 'pipeline-failed',
        failedAt: phaseId,
        retryable: action.retryable,
        error: intent.error,
      },
      nextAttempts: attempts,
      historyEntry,
      sideEffects,
    };
  }

  throw new Error(`Unexpected transition action for failed: ${action.kind}`);
}

function reduceAwaitGate(input: ReducerInput, phaseId: string): ReducerOutput {
  const { intent, history, startedAt, now } = input;
  if (intent.kind !== 'awaitGate') throw new Error('reduceAwaitGate requires awaitGate intent');

  const reason: GateReason = intent.reason;

  const historyEntry: PhaseHistoryEntry = {
    phaseId,
    attemptId: countAttempts(history, phaseId) + 1,
    startedAt,
    endedAt: now,
    outcome: 'gated',
    sessionId: intent.sessionId,
  };

  const sideEffects: ReducerSideEffect[] = [
    { kind: 'commit-artifacts', phaseId },
    {
      kind: 'emit-event',
      type: 'gate:requested',
      payload: { phaseId, reason },
    },
  ];

  return {
    nextState: {
      kind: 'gate-waiting',
      phaseId,
      reason,
      payload: intent.payload,
    },
    nextAttempts: 0,
    historyEntry,
    sideEffects,
  };
}

function reduceAwaitAsync(input: ReducerInput, phaseId: string): ReducerOutput {
  const { intent, attempts } = input;
  if (intent.kind !== 'awaitAsync') throw new Error('reduceAwaitAsync requires awaitAsync intent');

  // awaitAsync 不结束阶段、不写历史 — Orchestrator await 后会拿到最终 Intent 再次调用 Reducer
  return {
    nextState: { kind: 'running', phaseId },
    nextAttempts: attempts,
    historyEntry: {
      phaseId,
      attemptId: 0,
      startedAt: input.startedAt,
      outcome: 'completed',
    },
    sideEffects: [
      { kind: 'await-async', awaiter: intent.awaiter, phaseId },
    ],
  };
}

function reduceRequestRetryFrom(input: ReducerInput, phaseId: string): ReducerOutput {
  const { intent, pipeline, history, attempts, startedAt, now } = input;
  if (intent.kind !== 'requestRetryFrom') throw new Error('reduceRequestRetryFrom requires requestRetryFrom intent');

  const rule = findTransition(pipeline.transitions, phaseId, 'requestRetryFrom', intent);
  const action = rule?.action ?? {
    kind: 'fail-pipeline',
    retryable: 'manual',
  };

  const targetIdx = findPhaseIndex(pipeline, intent.targetPhaseId);
  const currentIdx = findPhaseIndex(pipeline, phaseId);
  if (targetIdx < 0 || targetIdx >= currentIdx) {
    return failPipeline(phaseId, intent, history, attempts, startedAt, now, 'manual',
      `Invalid retry-from target: '${intent.targetPhaseId}'`);
  }

  const retryFromContext = extractRetryFromContext(intent);

  const historyEntry: PhaseHistoryEntry = {
    phaseId,
    attemptId: countAttempts(history, phaseId) + 1,
    startedAt,
    endedAt: now,
    outcome: 'retried-from',
    sessionId: intent.sessionId,
    ...(retryFromContext ? { retryFromContext } : {}),
  };

  const sideEffects: ReducerSideEffect[] = [
    {
      kind: 'emit-event',
      type: 'phase:retryFrom',
      payload: { from: phaseId, to: intent.targetPhaseId, reason: intent.reason },
    },
  ];

  if (action.kind === 'retry-from') {
    const iterations = history.filter(
      (h) => h.phaseId === phaseId && h.outcome === 'retried-from',
    ).length + 1;

    if (iterations > action.maxIterations) {
      const error: PhaseError = {
        message: `${phaseId} retry-from loop exhausted after ${iterations} iterations`,
        retryable: 'hard-no-auto',
      };
      return {
        nextState: {
          kind: 'pipeline-failed',
          failedAt: phaseId,
          retryable: 'manual',
          error,
        },
        nextAttempts: attempts,
        historyEntry: { ...historyEntry, outcome: 'failed', errorMessage: error.message },
        sideEffects: [
          ...sideEffects,
          { kind: 'emit-event', type: 'phase:retryFromExhausted', payload: { phaseId } },
        ],
      };
    }

    return {
      nextState: { kind: 'running', phaseId: action.targetPhaseId },
      nextAttempts: action.resetAttempts ? 0 : attempts,
      historyEntry,
      sideEffects,
    };
  }

  return failPipeline(phaseId, intent, history, attempts, startedAt, now, 'manual',
    `No retry-from rule for '${phaseId}' → '${intent.targetPhaseId}'`);
}

/**
 * 从 RequestRetryFromIntent.context 中提取结构化的 RetryFromContext。
 *
 * intent.context 是宽松的 Record<string, unknown>（避免编排核心绑死阶段语义），
 * 这里负责把它收敛为 RetryFromContext 类型，供编排器在下轮调度时透传。
 *
 * 兼容两种 key 命名：
 * - `verifyFailures`（VerifyPhase 当前实现）
 * - `failures`（旧测试用例与潜在自定义阶段）
 *
 * 返回 undefined 表示无法识别有效上下文（不写 historyEntry，避免污染）。
 */
function extractRetryFromContext(intent: RequestRetryFromIntent): RetryFromContext | undefined {
  const ctx = intent.context;
  if (!ctx || typeof ctx !== 'object') return undefined;

  const rawFailures = (ctx as Record<string, unknown>).verifyFailures
    ?? (ctx as Record<string, unknown>).failures;
  const verifyFailures = Array.isArray(rawFailures)
    ? rawFailures.filter((x): x is string => typeof x === 'string')
    : [];

  const rawReportField = (ctx as Record<string, unknown>).rawReport;
  const rawReport = typeof rawReportField === 'string' ? rawReportField : '';

  if (verifyFailures.length === 0 && rawReport.length === 0) return undefined;

  return Object.freeze({
    verifyFailures: Object.freeze(verifyFailures),
    rawReport,
  });
}

// ---------------------------------------------------------------------------
// applyGateAction — 用户操作 gate 时的状态转移
// ---------------------------------------------------------------------------

export interface GateActionInput {
  readonly state: OrchestrationState;
  readonly action: GateAction;
  readonly pipeline: Pipeline;
  readonly now: string;
}

export interface GateActionOutput {
  readonly nextState: OrchestrationState;
  readonly historyEntry?: PhaseHistoryEntry;
  readonly sideEffects: readonly ReducerSideEffect[];
}

/**
 * 处理用户对 gate 的操作（approve / reject / supplement）。
 *
 * 前置条件：state.kind === 'gate-waiting'。
 * `reject` 仅在 phaseId === 'review' 时合法（Reducer 会抛错，由 API 层翻译为 409）。
 */
export function applyGateAction(input: GateActionInput): GateActionOutput {
  const { state, action, now } = input;
  if (state.kind !== 'gate-waiting') {
    throw new GateActionError(
      `Gate action requires state.kind === 'gate-waiting', got '${state.kind}'`,
      'invalid-state',
    );
  }

  const phaseId = state.phaseId;

  switch (action.action) {
    case 'approve': {
      const historyEntry: PhaseHistoryEntry = {
        phaseId,
        attemptId: 0,
        startedAt: now,
        endedAt: now,
        outcome: 'gate-approved',
      };

      //   由 Orchestrator.computeNextPhaseId 决定重跑当前 phase。
      // - 普通 gate（如 review）：进入 gate-approved；若是最后一阶段则直接 pipeline-completed。
      const spec = findPhaseSpec(input.pipeline, phaseId);
      const nextState: OrchestrationState = spec?.rerunOnApprove
        ? { kind: 'gate-approved', phaseId }
        : isLastPhase(input.pipeline, phaseId)
          ? { kind: 'pipeline-completed' }
          : { kind: 'gate-approved', phaseId };
      return {
        nextState,
        historyEntry,
        sideEffects: [
          { kind: 'emit-event', type: 'gate:approved', payload: { phaseId } },
        ],
      };
    }
    case 'reject': {
      if (phaseId !== 'review') {
        throw new GateActionError(
          `Reject only applies to review gate, current gate is '${phaseId}'`,
          'reject-not-allowed',
        );
      }
      const historyEntry: PhaseHistoryEntry = {
        phaseId,
        attemptId: 0,
        startedAt: now,
        endedAt: now,
        outcome: 'gate-rejected',
      };
      return {
        nextState: { kind: 'queued' },
        historyEntry,
        sideEffects: [
          {
            kind: 'emit-event',
            type: 'gate:rejected',
            payload: { phaseId, feedback: action.feedback },
          },
        ],
      };
    }
    case 'supplement': {
      // supplement 不改变状态，只发事件让外部存储补充上下文
      return {
        nextState: state,
        sideEffects: [
          {
            kind: 'emit-event',
            type: 'gate:supplemented',
            payload: { phaseId, context: action.context },
          },
        ],
      };
    }
  }
}

/** Gate 操作非法的结构化错误（API 层翻译为 409） */
export class GateActionError extends Error {
  constructor(message: string, public readonly code: 'invalid-state' | 'reject-not-allowed') {
    super(message);
    this.name = 'GateActionError';
  }
}

// ---------------------------------------------------------------------------
// 内部辅助函数
// ---------------------------------------------------------------------------

function findTransition(
  transitions: readonly TransitionRule[],
  phaseId: string,
  on: TransitionRule['on'],
  intent: PhaseIntent,
): TransitionRule | undefined {
  for (const rule of transitions) {
    if (rule.on !== on) continue;
    if (rule.from !== '*' && rule.from !== phaseId) continue;
    if (rule.match && !rule.match(intent)) continue;
    return rule;
  }
  return undefined;
}

function countAttempts(history: readonly PhaseHistoryEntry[], phaseId: string): number {
  return history.filter((h) => h.phaseId === phaseId).length;
}

function failPipeline(
  phaseId: string,
  intent: PhaseIntent,
  history: readonly PhaseHistoryEntry[],
  attempts: number,
  startedAt: string,
  now: string,
  retryable: 'auto' | 'manual',
  reason: string,
): ReducerOutput {
  const error: PhaseError =
    intent.kind === 'failed'
      ? intent.error
      : { message: reason, retryable: 'hard-no-auto' };
  const outcome: PhaseHistoryOutcome = 'failed';

  return {
    nextState: { kind: 'pipeline-failed', failedAt: phaseId, retryable, error },
    nextAttempts: attempts,
    historyEntry: {
      phaseId,
      attemptId: countAttempts(history, phaseId) + 1,
      startedAt,
      endedAt: now,
      outcome,
      errorMessage: error.message,
      sessionId: intent.kind === 'failed' ? intent.sessionId : undefined,
    },
    sideEffects: [
      {
        kind: 'emit-event',
        type: 'pipeline:failed',
        payload: { failedAt: phaseId, reason: error.message },
      },
    ],
  };
}
