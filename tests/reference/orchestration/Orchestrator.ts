import type { Pipeline } from './Pipeline.js';
import {
  findPhaseSpec,
  firstPhaseId,
  nextPhaseId,
} from './Pipeline.js';
import type {
  OrchestrationState,
  PhaseHistoryEntry,
  GateWaitingState,
  GateAction,
} from './OrchestrationState.js';
import { applyIntent, applyGateAction, type ReducerSideEffect } from './Reducer.js';
import type { PhaseIntent } from './Intent.js';
import type { PhaseRunner, PhaseRunnerContext } from './PhaseRunner.js';
import { logger as rootLogger } from '../../../src/logger.js';


export class Orchestrator {
  private readonly logger = rootLogger.child('Orchestrator');
  private readonly pipeline: Pipeline;
  private readonly phaseRunner: PhaseRunner;
  private readonly stateStore: OrchestratorStateStore;
  private readonly sideEffectExecutor: SideEffectExecutor;
  private readonly options: OrchestratorOptions;

  constructor(
    pipeline: Pipeline,
    phaseRunner: PhaseRunner,
    stateStore: OrchestratorStateStore,
    sideEffectExecutor: SideEffectExecutor,
    options: OrchestratorOptions = {},
  ) {
    this.pipeline = pipeline;
    this.phaseRunner = phaseRunner;
    this.stateStore = stateStore;
    this.sideEffectExecutor = sideEffectExecutor;
    this.options = options;
  }

  /** 当前流水线（不可变副本，无全局副作用） */
  getPipeline(): Pipeline {
    return this.pipeline;
  }

  /**
   * 驱动指定 issue 一直跑到 terminal / gate-waiting / paused。
   *
   * 主循环每轮：
   *   1. 从 stateStore 读当前 OrchestrationState + 历史
   *   2. 计算下一阶段（基于 state.kind）
   *   3. 调 phaseRunner.run 拿 PhaseIntent
   *   4. 调 applyIntent 算出 nextState + sideEffects + 历史条目
   *   5. 执行 sideEffects（commit / sync / event / await-async / create-pr）
   *   6. 写回 stateStore
   *   7. 判断是否终态/暂停 → 退出
   */
  async drive(number: number, runCtx: PhaseRunnerContext): Promise<void> {
    let safeguard = this.options.maxIterations ?? 100;

    while (safeguard-- > 0) {
      this.options.checkShutdown?.();

      const snapshot = this.stateStore.getSnapshot(number);
      const state = snapshot.state;

      if (!isDriveContinuable(state)) {
        this.logger.debug('State not drive-continuable, exiting drive loop', {
          number,
          stateKind: state.kind,
        });
        return;
      }

      const phaseId = this.computeNextPhaseId(state);
      if (!phaseId) {
        this.logger.warn('No next phase to run, treating as completed', { number, stateKind: state.kind });
        return;
      }

      const phaseSpec = findPhaseSpec(this.pipeline, phaseId);
      if (!phaseSpec) {
        this.logger.error('Phase not found in pipeline', { number, phaseId, pipelineId: this.pipeline.id });
        throw new Error(`Phase '${phaseId}' not found in pipeline '${this.pipeline.id}'`);
      }

      const startedAt = new Date().toISOString();
      this.stateStore.transitionToRunning(number, phaseId, startedAt);

      this.logger.info('Starting phase', { number, phaseId, attempts: snapshot.attempts });

      const fixIteration = this.computeFixIteration(snapshot.history, phaseId);
      const fixContext = fixIteration > 0
        ? this.findLastVerifyFailureContext(snapshot.history)
        : undefined;

      const phaseCtx: PhaseRunnerContext = {
        ...runCtx,
        fixIteration,
        verifyFailures: fixContext?.failures,
        rawReport: fixContext?.rawReport,
      };

      const intent = await this.phaseRunner.run(phaseSpec, phaseCtx);
      this.options.checkShutdown?.();
      const finalIntent = await this.resolveAsyncIntent(number, phaseId, intent);
      this.options.checkShutdown?.();

      const executionSnapshot = this.stateStore.getSnapshot(number);
      const out = applyIntent({
        state: { kind: 'running', phaseId },
        intent: finalIntent,
        pipeline: this.pipeline,
        history: snapshot.history,
        attempts: executionSnapshot.attempts,
        startedAt,
        now: new Date().toISOString(),
      });

      this.logger.info('Phase finished', {
        number,
        phaseId,
        intentKind: finalIntent.kind,
        nextStateKind: out.nextState.kind,
      });

      this.stateStore.applyTransition(number, {
        nextState: out.nextState,
        nextAttempts: out.nextAttempts,
        historyEntry: out.historyEntry,
      });
      this.options.checkShutdown?.();
      await this.executeSideEffects(number, phaseId, out.sideEffects);

      if (out.nextState.kind === 'gate-waiting') {
        const handled = await this.tryAutoApplyGate(number, out.nextState);
        if (handled) continue;
      }

      if (!isDriveContinuable(this.stateStore.getSnapshot(number).state)) {
        return;
      }
    }

    this.logger.warn('Drive loop exhausted safeguard counter', { number });
  }

  /**
   * 进入 gate-waiting 后，调用 onGateWaiting 回调判断是否可自动批准/驳回。
   *
   * 用途：
   * - GATE-5: review 阶段标签命中 auto-approve 列表 → 自动 approve
   * - GATE-6: release 阶段全局缓存命中（无可发布产物）→ 自动 approve
   *
   * 返回值：true 表示已应用 GateAction（state 已转移），可继续 drive；
   *         false 表示无 GateAction，drive 应退出等人工。
   */
  private async tryAutoApplyGate(number: number, state: GateWaitingState): Promise<boolean> {
    const handler = this.options.onGateWaiting;
    if (!handler) return false;
    try {
      const action = await handler(number, state);
      if (!action) return false;

      const out = applyGateAction({
        state,
        action,
        pipeline: this.pipeline,
        now: new Date().toISOString(),
      });

      const snapshot = this.stateStore.getSnapshot(number);
      const historyEntry: PhaseHistoryEntry = out.historyEntry ?? {
        phaseId: state.phaseId,
        attemptId: 0,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        outcome: action.action === 'approve' ? 'gate-approved' : 'gate-rejected',
      };
      this.stateStore.applyTransition(number, {
        nextState: out.nextState,
        nextAttempts: snapshot.attempts,
        historyEntry,
        expectedPlanRevision: state.payload?.planRevision as number | undefined,
        reviewFeedback: action.action === 'reject' ? action.feedback : undefined,
      });
      await this.executeSideEffects(number, state.phaseId, out.sideEffects);

      this.logger.info('Auto gate applied', {
        number,
        phaseId: state.phaseId,
        action: action.action,
        nextStateKind: out.nextState.kind,
      });
      return true;
    } catch (err) {
      this.logger.warn('onGateWaiting handler threw', {
        number,
        phaseId: state.phaseId,
        error: (err as Error).message,
      });
      return false;
    }
  }

  // ────────────────────────────────────────────────────────────
  // 内部辅助
  // ────────────────────────────────────────────────────────────

  /** 根据当前状态计算下一个要跑的阶段 ID */
  private computeNextPhaseId(state: OrchestrationState): string | undefined {
    switch (state.kind) {
      case 'queued':
        return firstPhaseId(this.pipeline);
      case 'running':
        return state.phaseId;
      case 'gate-approved': {

        // 普通 gate（如 review）：approve 后 advance 到下一阶段。
        const spec = findPhaseSpec(this.pipeline, state.phaseId);
        return spec?.rerunOnApprove ? state.phaseId : nextPhaseId(this.pipeline, state.phaseId);
      }
      case 'pipeline-failed':
        return state.retryable === 'auto' ? state.failedAt : undefined;
      case 'gate-waiting':
      case 'paused':
      case 'pipeline-completed':
      case 'conflict-resolving':
        return undefined;
    }
  }

  /** 计算指定阶段在 verify-fix loop 中的迭代轮次（基于历史） */
  private computeFixIteration(history: readonly PhaseHistoryEntry[], phaseId: string): number {
    if (phaseId !== 'build') return 0;
    return history.filter((h) => h.phaseId === 'verify' && h.outcome === 'retried-from').length;
  }

  /**
   * 从历史中找到最近一次 verify retried-from 的失败上下文。
   *
   * 数据流：
   * 1. VerifyPhase 失败时返回 `requestRetryFrom + context: { verifyFailures, rawReport }`
   * 2. Reducer.reduceRequestRetryFrom 把 context 提取为 RetryFromContext 写入 historyEntry.retryFromContext
   * 3. 这里读出来，让 Orchestrator 在下一轮 build 调度时透传给 PhaseRunner，
   *    最终由 BuildPhase 拼接到 prompt 让 AI 看到具体失败原因
   *
   * 若阶段历史未携带有效重试上下文，使用空失败列表和空报告。
   */
  private findLastVerifyFailureContext(
    history: readonly PhaseHistoryEntry[],
  ): { failures: readonly string[]; rawReport: string } | undefined {
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if (entry.phaseId === 'verify' && entry.outcome === 'retried-from') {
        const ctx = entry.retryFromContext;
        return {
          failures: ctx?.verifyFailures ?? [],
          rawReport: ctx?.rawReport ?? entry.errorMessage ?? '',
        };
      }
    }
    return undefined;
  }

  /** 处理 awaitAsync Intent：等待最终 Intent；其他类型直接透传 */
  private async resolveAsyncIntent(
    number: number,
    phaseId: string,
    intent: PhaseIntent,
  ): Promise<PhaseIntent> {
    if (intent.kind !== 'awaitAsync') return intent;
    this.logger.info('Awaiting async phase completion', { number, phaseId });
    try {
      return await intent.awaiter;
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error('Async phase awaiter threw', { number, phaseId, error: message });
      return {
        kind: 'failed',
        error: { message, retryable: 'hard' },
      };
    }
  }

  /** 顺序执行 Reducer 返回的副作用 */
  private async executeSideEffects(
    number: number,
    phaseId: string,
    sideEffects: readonly ReducerSideEffect[],
  ): Promise<void> {
    for (const effect of sideEffects) {
      this.options.checkShutdown?.();
      try {
        await this.sideEffectExecutor.execute(number, phaseId, effect);
      } catch (err) {
        this.logger.warn('Side effect execution failed', {
          number,
          phaseId,
          effectKind: effect.kind,
          error: (err as Error).message,
        });
      }
    }
  }
}

// ────────────────────────────────────────────────────────────
// Orchestrator 依赖接口
// ────────────────────────────────────────────────────────────

/** 状态存储抽象 — 把 OrchestrationState 持久化与查询从 Orchestrator 解耦 */
export interface OrchestratorStateStore {
  /** 读取 issue 当前的状态快照 */
  getSnapshot(number: number): OrchestrationStateSnapshot;

  /** 标记进入 running 状态（在调用 phaseRunner 之前） */
  transitionToRunning(number: number, phaseId: string, startedAt: string): void;

  /** 应用 Reducer 的转移结果 */
  applyTransition(number: number, transition: OrchestrationTransition): void;
}

/** 编排状态快照 */
export interface OrchestrationStateSnapshot {
  readonly state: OrchestrationState;
  readonly history: readonly PhaseHistoryEntry[];
  readonly attempts: number;
}

/** Reducer 输出的状态转移 */
export interface OrchestrationTransition {
  expectedPlanRevision?: number;
  reviewFeedback?: string;
  readonly nextState: OrchestrationState;
  readonly nextAttempts: number;
  readonly historyEntry: PhaseHistoryEntry;
}

/** 副作用执行器 — Orchestrator 把 Reducer 返回的副作用交给此对象执行 */
export interface SideEffectExecutor {
  execute(number: number, phaseId: string, effect: ReducerSideEffect): Promise<void>;
}

/** Orchestrator 行为开关 */
export interface OrchestratorOptions {
  /** 主循环最大迭代数（防止死循环） */
  readonly maxIterations?: number;
  /** 主循环每轮检测 shutdown 信号 */
  readonly checkShutdown?: () => void;
  /**
   * 进入 gate-waiting 时回调，可返回 GateAction 实现自动批准/驳回。
   * - 返回 GateAction → Orchestrator 应用并继续 drive
   * - 返回 undefined → 暂停等人工
   * - 抛错 → 暂停等人工（错误被吞掉记 warn）
   */
  readonly onGateWaiting?: (
    number: number,
    state: GateWaitingState,
  ) => Promise<GateAction | undefined> | GateAction | undefined;
}

// ────────────────────────────────────────────────────────────
// 内部辅助：drive 主循环是否应该继续
// ────────────────────────────────────────────────────────────

/**
 * Orchestrator 主循环是否应该再走一轮。
 *
 * 区别于公共 isDrivable（用于 Poller）：drive 内部 running 状态意味着
 * 「下一轮立即进入下一阶段」，而 Poller 看到 running 应该跳过。
 */
function isDriveContinuable(state: OrchestrationState): boolean {
  switch (state.kind) {
    case 'queued':
    case 'running':
    case 'gate-approved':
      return true;
    case 'pipeline-failed':
      return state.retryable === 'auto';
    case 'gate-waiting':
    case 'paused':
    case 'pipeline-completed':
    case 'conflict-resolving':
      return false;
  }
}
