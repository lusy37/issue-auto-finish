import { describe, it, expect } from 'vitest';
import {
  Orchestrator,
  applyGateAction,
  buildPipeline,
  PLAN_MODE_TRANSITIONS,
  type OrchestrationState,
  type OrchestrationStateSnapshot,
  type OrchestrationTransition,
  type OrchestratorStateStore,
  type PhaseHistoryEntry,
  type PhaseIntent,
  type PhaseRunner,
  type PhaseSpec,
  type ReducerSideEffect,
  type SideEffectExecutor,
} from '../../orchestration/index.js';

/**
 * 失败/恢复路径集成测试 — 覆盖 plan 中的 FAIL-1 ~ FAIL-7。
 *
 * 用真实 Orchestrator + Reducer，mock PhaseRunner / StateStore / SideEffectExecutor。
 * 上层接入（工作台重试 API、UI retry 按钮）的端到端验证留给 PR5。
 */

interface MockStateStore extends OrchestratorStateStore {
  getCurrentState(number: number): OrchestrationState;
  history: PhaseHistoryEntry[];
  attempts: { value: number };
  runningPhaseRecord: string[];
  setState(number: number, state: OrchestrationState): void;
}

function makeStateStore(initial: OrchestrationState = { kind: 'queued' }): MockStateStore {
  let state = initial;
  const history: PhaseHistoryEntry[] = [];
  const attempts = { value: 0 };
  const runningPhaseRecord: string[] = [];

  return {
    getSnapshot(_iid): OrchestrationStateSnapshot {
      return { state, history: [...history], attempts: attempts.value };
    },
    transitionToRunning(_iid, phaseId, _startedAt) {
      state = { kind: 'running', phaseId };
      runningPhaseRecord.push(phaseId);
    },
    applyTransition(_iid, transition: OrchestrationTransition) {
      state = transition.nextState;
      attempts.value = transition.nextAttempts;
      history.push(transition.historyEntry);
    },
    getCurrentState(): OrchestrationState {
      return state;
    },
    setState(_iid, newState) {
      state = newState;
    },
    history,
    attempts,
    runningPhaseRecord,
  };
}

function makeNoopExecutor(): SideEffectExecutor & { effects: ReducerSideEffect[] } {
  const effects: ReducerSideEffect[] = [];
  return {
    async execute(_iid, _phaseId, effect) {
      effects.push(effect);
    },
    effects,
  };
}

function makeRunner(intents: Record<string, PhaseIntent | (() => Promise<PhaseIntent>)>): PhaseRunner {
  return {
    async run(spec: PhaseSpec): Promise<PhaseIntent> {
      const entry = intents[spec.id];
      if (!entry) return { kind: 'completed' };
      return typeof entry === 'function' ? await entry() : entry;
    },
  };
}

const baseRunCtx = {
  issueIid: 100,
  demand: undefined,
  branchName: 'feat/issue-100',
  workDir: '/tmp/issue-100',
};

describe('FAIL-1: hard 失败 + retry budget', () => {
  it('hard 失败连续重试 → 第 N 次成功，状态 pipeline-completed', async () => {
    const pipeline = buildPipeline({ release: false, e2e: false }, PLAN_MODE_TRANSITIONS);
    const stateStore = makeStateStore();
    const executor = makeNoopExecutor();

    let calls = 0;
    const runner = makeRunner({
      plan: async () => {
        calls += 1;
        if (calls < 3) return { kind: 'failed', error: { message: 'flaky', retryable: 'hard' } };
        return { kind: 'completed' };
      },
      review: { kind: 'awaitGate', reason: 'human-review' },
    });

    const orch = new Orchestrator(pipeline, runner, stateStore, executor, {
      onGateWaiting: () => ({ action: 'approve' }),
    });
    await orch.drive(100, baseRunCtx);

    expect(calls).toBe(3);
    expect(stateStore.getCurrentState(100).kind).toBe('pipeline-completed');
  });

  it('hard 失败超过 maxAttempts → pipeline-failed manual', async () => {
    const pipeline = buildPipeline({ release: false, e2e: false }, PLAN_MODE_TRANSITIONS);
    const stateStore = makeStateStore();
    const executor = makeNoopExecutor();

    const runner = makeRunner({
      plan: { kind: 'failed', error: { message: 'persistent', retryable: 'hard' } },
    });

    const orch = new Orchestrator(pipeline, runner, stateStore, executor, { maxIterations: 10 });
    await orch.drive(100, baseRunCtx);

    const final = stateStore.getCurrentState(100);
    expect(final.kind).toBe('pipeline-failed');
    if (final.kind === 'pipeline-failed') {
      expect(final.retryable).toBe('manual');
      expect(final.failedAt).toBe('plan');
    }
  });
});

describe('FAIL-2: verify-fix loop', () => {
  it('verify 第一次失败回退 build，第二次 verify 通过', async () => {
    const pipeline = buildPipeline({ release: false, e2e: false }, PLAN_MODE_TRANSITIONS);
    const stateStore = makeStateStore();
    const executor = makeNoopExecutor();

    let verifyCalls = 0;
    const runner = makeRunner({
      review: { kind: 'awaitGate', reason: 'human-review' },
      verify: async () => {
        verifyCalls += 1;
        if (verifyCalls === 1) {
          return {
            kind: 'requestRetryFrom',
            targetPhaseId: 'build',
            reason: 'verify-failed',
            context: { failures: ['fail-A'], rawReport: 'first attempt failed' },
          };
        }
        return { kind: 'completed' };
      },
    });

    const orch = new Orchestrator(pipeline, runner, stateStore, executor, {
      onGateWaiting: () => ({ action: 'approve' }),
    });
    await orch.drive(100, baseRunCtx);

    expect(verifyCalls).toBe(2);
    expect(stateStore.runningPhaseRecord.filter((p) => p === 'build')).toHaveLength(2);
    expect(stateStore.runningPhaseRecord.filter((p) => p === 'verify')).toHaveLength(2);
    expect(stateStore.getCurrentState(100).kind).toBe('pipeline-completed');
  });
});

describe('FAIL-3: verify-fix loop 用尽迭代', () => {
  it('verify 持续失败 → 最终 pipeline-failed manual', async () => {
    const pipeline = buildPipeline({ release: false, e2e: false }, PLAN_MODE_TRANSITIONS);
    const stateStore = makeStateStore();
    const executor = makeNoopExecutor();

    const runner = makeRunner({
      review: { kind: 'awaitGate', reason: 'human-review' },
      verify: {
        kind: 'requestRetryFrom',
        targetPhaseId: 'build',
        reason: 'verify-failed',
        context: { failures: ['perma-fail'], rawReport: 'never works' },
      },
    });

    const orch = new Orchestrator(pipeline, runner, stateStore, executor, {
      maxIterations: 30,
      onGateWaiting: () => ({ action: 'approve' }),
    });
    await orch.drive(100, baseRunCtx);

    const final = stateStore.getCurrentState(100);
    expect(final.kind).toBe('pipeline-failed');
    if (final.kind === 'pipeline-failed') {
      expect(final.retryable).toBe('manual');
    }
  });
});

describe('FAIL-5: soft 失败不消耗 budget', () => {
  it('soft 失败 N 次后成功 → attempts 计数仍然为 0', async () => {
    const pipeline = buildPipeline({ release: false, e2e: false }, PLAN_MODE_TRANSITIONS);
    const stateStore = makeStateStore();
    const executor = makeNoopExecutor();

    let calls = 0;
    const runner = makeRunner({
      plan: async () => {
        calls += 1;
        if (calls < 4) return { kind: 'failed', error: { message: 'soft', retryable: 'soft' } };
        return { kind: 'completed' };
      },
      review: { kind: 'awaitGate', reason: 'human-review' },
    });

    const orch = new Orchestrator(pipeline, runner, stateStore, executor, {
      onGateWaiting: () => ({ action: 'approve' }),
    });
    await orch.drive(100, baseRunCtx);

    expect(calls).toBe(4);
    expect(stateStore.attempts.value).toBe(0);
    expect(stateStore.getCurrentState(100).kind).toBe('pipeline-completed');
  });
});

describe('FAIL-6: 进程崩溃后恢复', () => {
  it('从 gate-approved(plan) 启动 → 继续 review→build→verify', async () => {
    const pipeline = buildPipeline({ release: false, e2e: false }, PLAN_MODE_TRANSITIONS);
    const stateStore = makeStateStore({ kind: 'gate-approved', phaseId: 'plan' });
    const executor = makeNoopExecutor();

    const runner = makeRunner({
      review: { kind: 'awaitGate', reason: 'human-review' },
    });

    const orch = new Orchestrator(pipeline, runner, stateStore, executor, {
      onGateWaiting: () => ({ action: 'approve' }),
    });
    await orch.drive(100, baseRunCtx);

    expect(stateStore.runningPhaseRecord).toEqual(['review', 'build', 'verify']);
    expect(stateStore.getCurrentState(100).kind).toBe('pipeline-completed');
  });

  it('从 pipeline-failed auto 启动 → 立即重试', async () => {
    const pipeline = buildPipeline({ release: false, e2e: false }, PLAN_MODE_TRANSITIONS);
    const stateStore = makeStateStore({
      kind: 'pipeline-failed',
      failedAt: 'plan',
      retryable: 'auto',
      error: { message: 'auto-retry', retryable: 'soft' },
    });
    const executor = makeNoopExecutor();

    const runner = makeRunner({
      plan: { kind: 'completed' },
      review: { kind: 'awaitGate', reason: 'human-review' },
    });

    const orch = new Orchestrator(pipeline, runner, stateStore, executor, {
      onGateWaiting: () => ({ action: 'approve' }),
    });
    await orch.drive(100, baseRunCtx);

    expect(stateStore.runningPhaseRecord[0]).toBe('plan');
    expect(stateStore.getCurrentState(100).kind).toBe('pipeline-completed');
  });
});

describe('FAIL-7: shutdown 信号中断', () => {
  it('checkShutdown 抛错 → drive 退出，状态保留', async () => {
    const pipeline = buildPipeline({ release: false, e2e: false }, PLAN_MODE_TRANSITIONS);
    const stateStore = makeStateStore();
    const executor = makeNoopExecutor();
    let cancelTriggered = false;

    const runner = makeRunner({
      plan: async () => {
        cancelTriggered = true;
        return { kind: 'completed' };
      },
    });

    const orch = new Orchestrator(pipeline, runner, stateStore, executor, {
      checkShutdown: () => {
        if (cancelTriggered) throw new Error('shutdown signal');
      },
    });

    await expect(orch.drive(100, baseRunCtx)).rejects.toThrow(/shutdown signal/);
    expect(cancelTriggered).toBe(true);
  });
});

describe('FAIL-4: 审核驳回后重新驱动', () => {
  it('Reducer.applyGateAction reject 后再次 drive 走 review 流程', async () => {
    const pipeline = buildPipeline({ release: false, e2e: false }, PLAN_MODE_TRANSITIONS);
    const stateStore = makeStateStore();
    const executor = makeNoopExecutor();

    let planRun = 0;
    const runner = makeRunner({
      plan: async () => {
        planRun += 1;
        return { kind: 'completed' };
      },
      review: { kind: 'awaitGate', reason: 'human-review' },
    });

    let firstReject = true;
    const orch = new Orchestrator(pipeline, runner, stateStore, executor, {
      onGateWaiting: (_iid, state) => {
        if (state.phaseId === 'review' && firstReject) {
          firstReject = false;
          return { action: 'reject', feedback: '需要重做' };
        }
        return { action: 'approve' };
      },
    });
    await orch.drive(100, baseRunCtx);

    expect(planRun).toBeGreaterThanOrEqual(2);
    expect(stateStore.getCurrentState(100).kind).toBe('pipeline-completed');
  });

  it('applyGateAction reject 在非 review 阶段抛错', () => {
    const pipeline = buildPipeline({ release: true, e2e: false }, PLAN_MODE_TRANSITIONS);
    expect(() =>
      applyGateAction({
        state: { kind: 'gate-waiting', phaseId: 'release', reason: 'release-confirm' },
        action: { action: 'reject', feedback: 'no' },
        pipeline,
        now: new Date().toISOString(),
      }),
    ).toThrow(/Reject only applies to review gate/);
  });
});
