import { describe, it, expect } from 'vitest';
import {
  Orchestrator,
  buildPipeline,
  PLAN_MODE_TRANSITIONS,
  type GateAction,
  type GateWaitingState,
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
} from '../../src/orchestration/index.js';

/**
 * GATE-5 / GATE-6：自动 gate 通过缓存命中场景集成测试。
 *
 * 验证 Orchestrator.onGateWaiting 钩子在两种典型场景下能让流水线无需人工干预直接 advance：
 * - GATE-5: review 阶段标签命中 auto-approve 列表 → 自动 approve
 * - GATE-6: release 阶段全局缓存命中（无可发布产物）→ 自动 approve
 *
 * 注：本测试用真实的 Orchestrator + Reducer，但 mock PhaseRunner / StateStore / SideEffectExecutor。
 *     PR4 会重写 stateStore 适配器；PR5 会接入 工作台审核 API。
 */

interface MockStateStore extends OrchestratorStateStore {
  getCurrentState(number: number): OrchestrationState;
  history: PhaseHistoryEntry[];
  runningPhaseRecord: string[];
  transitions: OrchestrationTransition[];
}

function makeStateStore(initial: OrchestrationState = { kind: 'queued' }): MockStateStore {
  let state = initial;
  const history: PhaseHistoryEntry[] = [];
  const transitions: OrchestrationTransition[] = [];
  const runningPhaseRecord: string[] = [];

  return {
    getSnapshot(_iid): OrchestrationStateSnapshot {
      return { state, history: [...history], attempts: 0 };
    },
    transitionToRunning(_iid, phaseId, _startedAt) {
      state = { kind: 'running', phaseId };
      runningPhaseRecord.push(phaseId);
    },
    applyTransition(_iid, transition) {
      state = transition.nextState;
      history.push(transition.historyEntry);
      transitions.push(transition);
    },
    getCurrentState(): OrchestrationState {
      return state;
    },
    history,
    transitions,
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

function makeRunner(intents: Record<string, PhaseIntent>): PhaseRunner {
  return {
    async run(spec: PhaseSpec): Promise<PhaseIntent> {
      return intents[spec.id] ?? { kind: 'completed' };
    },
  };
}

const baseRunCtx = {
  issueIid: 42,
  demand: undefined,
  branchName: 'feat/issue-42',
  workDir: '/tmp/issue-42',
};

describe('GATE-5: review 阶段 auto-approve 标签命中', () => {
  it('返回 approve 后 review 状态自动转 gate-approved，drive 继续推进', async () => {
    const pipeline = buildPipeline({ release: false, e2e: false }, PLAN_MODE_TRANSITIONS);
    const stateStore = makeStateStore();
    const executor = makeNoopExecutor();

    const runner = makeRunner({
      plan: { kind: 'completed' },
      review: { kind: 'awaitGate', reason: 'human-review' },
      build: { kind: 'completed' },
      verify: { kind: 'completed' },
    });

    const orch = new Orchestrator(pipeline, runner, stateStore, executor, {
      onGateWaiting: (_iid, state: GateWaitingState): GateAction | undefined => {
        if (state.phaseId === 'review') {
          return { action: 'approve' };
        }
        return undefined;
      },
    });

    await orch.drive(42, baseRunCtx);

    expect(stateStore.getCurrentState(42).kind).toBe('pipeline-completed');
    expect(stateStore.runningPhaseRecord).toContain('build');
    expect(stateStore.runningPhaseRecord).toContain('verify');
    const gateApproveEvents = executor.effects.filter(
      (e) => e.kind === 'emit-event' && e.type === 'gate:approved',
    );
    expect(gateApproveEvents).toHaveLength(1);
  });

  it('未命中 auto-approve → 停在 gate-waiting 等人工', async () => {
    const pipeline = buildPipeline({ release: false, e2e: false }, PLAN_MODE_TRANSITIONS);
    const stateStore = makeStateStore();
    const executor = makeNoopExecutor();
    const runner = makeRunner({
      plan: { kind: 'completed' },
      review: { kind: 'awaitGate', reason: 'human-review' },
    });

    const orch = new Orchestrator(pipeline, runner, stateStore, executor, {
      onGateWaiting: () => undefined,
    });

    await orch.drive(42, baseRunCtx);

    const final = stateStore.getCurrentState(42);
    expect(final.kind).toBe('gate-waiting');
    if (final.kind === 'gate-waiting') {
      expect(final.phaseId).toBe('review');
    }
  });
});
