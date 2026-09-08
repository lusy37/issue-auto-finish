import { describe, it, expect, vi } from 'vitest';
import {
  Orchestrator,
  buildPipeline,
  PLAN_MODE_TRANSITIONS,
  type OrchestrationState,
  type OrchestrationStateSnapshot,
  type OrchestrationTransition,
  type OrchestratorStateStore,
  type SideEffectExecutor,
  type PhaseHistoryEntry,
  type PhaseIntent,
  type PhaseRunner,
  type PhaseRunnerContext,
  type PhaseSpec,
  type ReducerSideEffect,
} from '../../src/orchestration/index.js';

/**
 * Orchestrator.drive() 单元测试 — 覆盖 FAIL-1/6/7、GATE-5/6 的核心驱动逻辑。
 *
 * 用纯 mock 的 PhaseRunner / StateStore / SideEffectExecutor 注入到真实 Orchestrator，
 * 验证状态驱动行为：
 * - drive 退出时机（gate-waiting / paused / pipeline-completed / pipeline-failed-manual）
 * - 重试自动驱动（pipeline-failed-auto）
 * - shutdown 信号中断
 * - sideEffect 执行顺序
 * - awaitAsync 处理
 */

// ────────────────────────────────────────────────────────────
// Mock 实现
// ────────────────────────────────────────────────────────────

function buildPipelineForTest() {
  return buildPipeline({ release: false, e2e: false }, PLAN_MODE_TRANSITIONS);
}

function buildPipelineWithUat() {
  return buildPipeline({ e2e: true }, PLAN_MODE_TRANSITIONS);
}

interface MockStateStore extends OrchestratorStateStore {
  setState(number: number, state: OrchestrationState): void;
  history: PhaseHistoryEntry[];
  attemptsHolder: { value: number };
  getCurrentState(number: number): OrchestrationState;
  transitions: OrchestrationTransition[];
  runningPhaseRecord: string[];
}

function makeStateStore(initialState: OrchestrationState = { kind: 'queued' }): MockStateStore {
  let state = initialState;
  const history: PhaseHistoryEntry[] = [];
  const attemptsHolder = { value: 0 };
  const transitions: OrchestrationTransition[] = [];
  const runningPhaseRecord: string[] = [];

  return {
    getSnapshot(_iid: number): OrchestrationStateSnapshot {
      return {
        state,
        history: [...history],
        attempts: attemptsHolder.value,
      };
    },
    transitionToRunning(_iid: number, phaseId: string, _startedAt: string): void {
      state = { kind: 'running', phaseId };
      runningPhaseRecord.push(phaseId);
    },
    applyTransition(_iid: number, transition: OrchestrationTransition): void {
      state = transition.nextState;
      attemptsHolder.value = transition.nextAttempts;
      history.push(transition.historyEntry);
      transitions.push(transition);
    },
    setState(_iid: number, newState: OrchestrationState) {
      state = newState;
    },
    getCurrentState(): OrchestrationState {
      return state;
    },
    history,
    attemptsHolder,
    transitions,
    runningPhaseRecord,
  };
}

function makeSideEffectExecutor(): SideEffectExecutor & { effects: Array<{ phaseId: string; effect: ReducerSideEffect }> } {
  const effects: Array<{ phaseId: string; effect: ReducerSideEffect }> = [];
  return {
    async execute(_iid, phaseId, effect) {
      effects.push({ phaseId, effect });
    },
    effects,
  };
}

function makePhaseRunner(intentByPhase: Record<string, PhaseIntent | (() => Promise<PhaseIntent>)>): PhaseRunner {
  return {
    async run(spec: PhaseSpec, _ctx: PhaseRunnerContext): Promise<PhaseIntent> {
      const entry = intentByPhase[spec.id];
      if (!entry) {
        return { kind: 'completed', output: `${spec.id}-default-completed` };
      }
      return typeof entry === 'function' ? await entry() : entry;
    },
  };
}

const baseRunCtx: PhaseRunnerContext = {
  issueIid: 1,
  demand: undefined,
  branchName: 'feat/issue-1',
  workDir: '/tmp/issue-1',
};

it.each(['completed', 'failed', 'awaitAsync'] as const)('等待 %s 结果期间取消，不提交结果或执行后续副作用', async (kind) => {
  let stopped = false;
  const store = makeStateStore();
  const effects = makeSideEffectExecutor();
  const runner: PhaseRunner = {
    async run() {
      const result: PhaseIntent = kind === 'completed'
        ? { kind: 'completed', output: '已完成' }
        : { kind: 'failed', error: { message: '执行已取消', retryable: 'hard-no-auto' } };
      if (kind === 'awaitAsync') {
        return { kind: 'awaitAsync', awaiter: Promise.resolve().then(() => { stopped = true; return result; }) };
      }
      stopped = true;
      return result;
    },
  };
  const orchestrator = new Orchestrator(buildPipelineForTest(), runner, store, effects, {
    checkShutdown: () => { if (stopped) throw new Error('用户已取消'); },
  });
  await expect(orchestrator.drive(1, baseRunCtx)).rejects.toThrow('用户已取消');
  expect(store.transitions).toHaveLength(0);
  expect(effects.effects).toHaveLength(0);
});

// ────────────────────────────────────────────────────────────
// 测试用例
// ────────────────────────────────────────────────────────────

describe('Orchestrator.drive(): 顺利完成路径', () => {
  it('plan→build→verify 全成功 → pipeline-completed', async () => {
    const pipeline = buildPipelineForTest();
    const stateStore = makeStateStore({ kind: 'queued' });
    const executor = makeSideEffectExecutor();
    // review 是 gate 类型，会触发 awaitGate；为简化，让 review 直接 completed
    const runner = makePhaseRunner({
      plan: { kind: 'completed' },
      review: { kind: 'completed' },
      build: { kind: 'completed' },
      verify: { kind: 'completed' },
    });

    const orch = new Orchestrator(pipeline, runner, stateStore, executor);
    await orch.drive(1, baseRunCtx);

    expect(stateStore.getCurrentState(1)).toEqual({ kind: 'pipeline-completed' });
    expect(stateStore.runningPhaseRecord).toEqual(['plan', 'review', 'build', 'verify']);
  });
});

describe('Orchestrator.drive(): 暂停 / 终态退出', () => {
  it('GATE-5/6: review awaitGate → gate-waiting，drive 退出', async () => {
    const pipeline = buildPipelineForTest();
    const stateStore = makeStateStore({ kind: 'queued' });
    const executor = makeSideEffectExecutor();
    const runner = makePhaseRunner({
      plan: { kind: 'completed' },
      review: { kind: 'awaitGate', reason: 'human-review' },
    });

    const orch = new Orchestrator(pipeline, runner, stateStore, executor);
    await orch.drive(1, baseRunCtx);

    const final = stateStore.getCurrentState(1);
    expect(final.kind).toBe('gate-waiting');
    if (final.kind === 'gate-waiting') {
      expect(final.phaseId).toBe('review');
    }
  });
});

describe('Orchestrator.drive(): 失败处理', () => {
  it('FAIL-1: plan hard 失败 + retry budget 充足 → 自动重试同阶段', async () => {
    const pipeline = buildPipelineForTest();
    const stateStore = makeStateStore({ kind: 'queued' });
    const executor = makeSideEffectExecutor();
    let callCount = 0;
    const runner: PhaseRunner = {
      async run(spec) {
        if (spec.id === 'plan') {
          callCount += 1;
          if (callCount === 1) {
            return { kind: 'failed', error: { message: 'flaky', retryable: 'hard' } };
          }
        }
        return { kind: 'completed' };
      },
    };

    const orch = new Orchestrator(pipeline, runner, stateStore, executor);
    await orch.drive(1, baseRunCtx);

    expect(callCount).toBeGreaterThanOrEqual(2);
    const final = stateStore.getCurrentState(1);
    expect(final.kind).toBe('pipeline-completed');
  });

  it('FAIL-1: hard 失败超过 maxAttempts → pipeline-failed manual + drive 退出', async () => {
    const pipeline = buildPipelineForTest();
    const stateStore = makeStateStore({ kind: 'queued' });
    const executor = makeSideEffectExecutor();
    const runner = makePhaseRunner({
      plan: { kind: 'failed', error: { message: 'persistent', retryable: 'hard' } },
    });

    const orch = new Orchestrator(pipeline, runner, stateStore, executor, { maxIterations: 10 });
    await orch.drive(1, baseRunCtx);

    const final = stateStore.getCurrentState(1);
    expect(final.kind).toBe('pipeline-failed');
    if (final.kind === 'pipeline-failed') {
      expect(final.retryable).toBe('manual');
      expect(final.failedAt).toBe('plan');
    }
  });

  it('FAIL-3: hard-no-auto 失败 → pipeline-failed manual + 立即退出（不重试）', async () => {
    const pipeline = buildPipelineForTest();
    const stateStore = makeStateStore({ kind: 'queued' });
    const executor = makeSideEffectExecutor();
    let callCount = 0;
    const runner: PhaseRunner = {
      async run(spec) {
        if (spec.id === 'plan') {
          callCount += 1;
          return { kind: 'failed', error: { message: 'no-auto', retryable: 'hard-no-auto' } };
        }
        return { kind: 'completed' };
      },
    };

    const orch = new Orchestrator(pipeline, runner, stateStore, executor);
    await orch.drive(1, baseRunCtx);

    expect(callCount).toBe(1);
    expect(stateStore.getCurrentState(1).kind).toBe('pipeline-failed');
  });
});

describe('Orchestrator.drive(): 进程恢复 / shutdown', () => {
  it('FAIL-6: drive 重新启动后从当前状态继续（已完成 plan，从 review 继续）', async () => {
    const pipeline = buildPipelineForTest();
    // 模拟「plan 已完成」的进程崩溃后状态：state = gate-approved(plan)
    const stateStore = makeStateStore({ kind: 'gate-approved', phaseId: 'plan' });
    const executor = makeSideEffectExecutor();
    const runner = makePhaseRunner({
      review: { kind: 'completed' },
      build: { kind: 'completed' },
      verify: { kind: 'completed' },
    });

    const orch = new Orchestrator(pipeline, runner, stateStore, executor);
    await orch.drive(1, baseRunCtx);

    expect(stateStore.runningPhaseRecord).toEqual(['review', 'build', 'verify']);
    expect(stateStore.getCurrentState(1).kind).toBe('pipeline-completed');
  });

  it('FAIL-7: shutdown 信号 → drive 抛错并退出，状态保留', async () => {
    const pipeline = buildPipelineForTest();
    const stateStore = makeStateStore({ kind: 'queued' });
    const executor = makeSideEffectExecutor();
    let shutdown = false;
    const runner = makePhaseRunner({
      plan: async () => {
        shutdown = true;
        return { kind: 'completed' };
      },
    });

    const orch = new Orchestrator(pipeline, runner, stateStore, executor, {
      checkShutdown: () => {
        if (shutdown) throw new Error('Service is shutting down');
      },
    });

    // 第一次 drive：plan 跑完后 checkShutdown 触发 → 退出（review 不会启动）
    await expect(orch.drive(1, baseRunCtx)).rejects.toThrow(/shutting down/);
  });
});

describe('Orchestrator.drive(): 异步处理', () => {
  it('awaitAsync 解析后再走 reducer，最终状态正确', async () => {
    const pipeline = buildPipelineWithUat();
    const stateStore = makeStateStore({ kind: 'queued' });
    const executor = makeSideEffectExecutor();
    const asyncResolved: PhaseIntent = { kind: 'completed', output: 'async ok' };

    let asyncCalled = false;
    const runner = makePhaseRunner({
      plan: { kind: 'completed' },
      review: { kind: 'completed' },
      build: { kind: 'completed' },
      verify: { kind: 'completed' },
      uat: {
        kind: 'awaitAsync',
        awaiter: (async () => {
          asyncCalled = true;
          return asyncResolved;
        })(),
      },
    });

    const orch = new Orchestrator(pipeline, runner, stateStore, executor);
    await orch.drive(1, baseRunCtx);

    expect(asyncCalled).toBe(true);
    expect(stateStore.getCurrentState(1).kind).toBe('pipeline-completed');
  });

  it('awaitAsync awaiter 抛错 → 转为 failed hard', async () => {
    const pipeline = buildPipelineWithUat();
    const stateStore = makeStateStore({ kind: 'queued' });
    const executor = makeSideEffectExecutor();
    const runner = makePhaseRunner({
      plan: { kind: 'completed' },
      review: { kind: 'completed' },
      build: { kind: 'completed' },
      verify: { kind: 'completed' },
      uat: {
        kind: 'awaitAsync',
        awaiter: Promise.reject(new Error('async failed')),
      },
    });

    const orch = new Orchestrator(pipeline, runner, stateStore, executor);
    await orch.drive(1, baseRunCtx);

    const final = stateStore.getCurrentState(1);
    expect(final.kind).toBe('pipeline-failed');
  });
});

describe('Orchestrator.drive(): verify-fix 循环驱动', () => {
  it('FAIL-2: verify→build 一次回退 + 再次 verify 通过 → pipeline-completed', async () => {
    const pipeline = buildPipelineForTest();
    const stateStore = makeStateStore({ kind: 'queued' });
    const executor = makeSideEffectExecutor();
    let verifyCount = 0;
    const runner: PhaseRunner = {
      async run(spec) {
        if (spec.id === 'verify') {
          verifyCount += 1;
          if (verifyCount === 1) {
            return {
              kind: 'requestRetryFrom',
              targetPhaseId: 'build',
              reason: 'verify-failed',
              context: { failures: ['fail-A'], rawReport: 'first-fail' },
            };
          }
        }
        return { kind: 'completed' };
      },
    };

    const orch = new Orchestrator(pipeline, runner, stateStore, executor);
    await orch.drive(1, baseRunCtx);

    expect(verifyCount).toBe(2);
    expect(stateStore.runningPhaseRecord).toEqual(['plan', 'review', 'build', 'verify', 'build', 'verify']);
    expect(stateStore.getCurrentState(1).kind).toBe('pipeline-completed');
  });

  it('FAIL-2 context-propagation: verify 携带的 verifyFailures/rawReport 必须传给下轮 build', async () => {
    // 复现 issue-179 现象：verify-fix loop 跑了 N 轮，但 build 拿到的 fixContext 永远是
    // verifyFailures=[] / rawReport=''，导致 AI 不知道要修什么，todolist 一直 0/N
    const pipeline = buildPipelineForTest();
    const stateStore = makeStateStore({ kind: 'queued' });
    const executor = makeSideEffectExecutor();

    let verifyCount = 0;
    const buildContexts: PhaseRunnerContext[] = [];
    const runner: PhaseRunner = {
      async run(spec, ctx) {
        if (spec.id === 'build') {
          buildContexts.push({ ...ctx });
        }
        if (spec.id === 'verify') {
          verifyCount += 1;
          if (verifyCount === 1) {
            return {
              kind: 'requestRetryFrom',
              targetPhaseId: 'build',
              reason: 'verify-failed',
              context: {
                verifyFailures: ['Todolist 未全部完成(0/18)', 'Lint 检查失败'],
                rawReport: '## 验证报告\n\nLint Result: Failed\nTodolist: 0/18',
                todolistStats: { completed: 0, total: 18 },
              },
            };
          }
        }
        return { kind: 'completed' };
      },
    };

    const orch = new Orchestrator(pipeline, runner, stateStore, executor);
    await orch.drive(1, baseRunCtx);

    expect(buildContexts).toHaveLength(2);
    // 第一次 build：无修复上下文
    expect(buildContexts[0].fixIteration ?? 0).toBe(0);
    expect(buildContexts[0].verifyFailures).toBeUndefined();
    // 第二次 build（修复迭代）：必须携带 verify 返回的具体失败原因和原始报告
    expect(buildContexts[1].fixIteration).toBe(1);
    expect(buildContexts[1].verifyFailures).toEqual(['Todolist 未全部完成(0/18)', 'Lint 检查失败']);
    expect(buildContexts[1].rawReport).toContain('Todolist: 0/18');
  });
});

describe('Orchestrator.drive(): sideEffect 执行', () => {
  it('completed 阶段触发 commit-artifacts + sync-result-to-issue', async () => {
    const pipeline = buildPipelineForTest();
    const stateStore = makeStateStore({ kind: 'queued' });
    const executor = makeSideEffectExecutor();
    const runner = makePhaseRunner({
      plan: { kind: 'completed' },
      review: { kind: 'awaitGate', reason: 'human-review' },
    });

    const orch = new Orchestrator(pipeline, runner, stateStore, executor);
    await orch.drive(1, baseRunCtx);

    const planEffects = executor.effects.filter((e) => e.effect.kind === 'commit-artifacts' && e.effect.phaseId === 'plan');
    expect(planEffects).toHaveLength(1);
    const syncEffects = executor.effects.filter((e) => e.effect.kind === 'sync-result-to-issue' && e.effect.phaseId === 'plan');
    expect(syncEffects).toHaveLength(1);
  });

  it('SideEffect 异常不应中断主循环', async () => {
    const pipeline = buildPipelineForTest();
    const stateStore = makeStateStore({ kind: 'queued' });
    const executor: SideEffectExecutor = {
      execute: vi.fn().mockRejectedValue(new Error('sideEffect-throw')),
    };
    const runner = makePhaseRunner({
      plan: { kind: 'completed' },
      review: { kind: 'awaitGate', reason: 'human-review' },
    });

    const orch = new Orchestrator(pipeline, runner, stateStore, executor);
    await orch.drive(1, baseRunCtx);

    expect(stateStore.getCurrentState(1).kind).toBe('gate-waiting');
  });
});
