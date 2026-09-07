import type {
  PhaseIntent,
  PhaseRunner,
  PhaseRunnerContext,
  PhaseSpec,
} from '../orchestration/index.js';
import type { PhaseContext } from '../phases/BasePhase.js';
import type { PhaseCallbacks } from '../phases/PhaseCallbacks.js';
import type { AIRunner, StreamEvent } from '../ai-runner/index.js';
import type { GitOperations } from '../git/GitOperations.js';
import type { PlanPersistence } from '../persistence/PlanPersistence.js';
import type { EventBus } from '../events/EventBus.js';
import type { Config } from '../config.js';
import type { DemandSpec } from '../demand/DemandSpec.js';
import type { WorkspaceLayout } from '../prompts/templates.js';
import type { PortPair } from '../deploy/PortAllocator.js';
import { createPhase } from '../phases/PhaseFactory.js';

/** PhaseRunner 实现需要的依赖 */
export interface StandardPhaseRunnerDeps {
  readonly aiRunner: AIRunner;
  readonly wtGit: GitOperations;
  readonly wtPlan: PlanPersistence;
  readonly config: Config;
  readonly eventBus: EventBus;
}

/**
 * 标准 PhaseRunner 实现 — 通过 PhaseFactory 创建阶段实例并调用 run()。
 *
 * 该类是 src/orchestration/PhaseRunner 接口的默认实现，
 * 持有具体的 git / tracker 之外的副作用通道（仅 EventBus 用于流式事件转发）。
 *
 * 不做编排决策；不写状态；只调用 phase.run() 拿 PhaseIntent。
 */
export class StandardPhaseRunner implements PhaseRunner {
  private readonly deps: StandardPhaseRunnerDeps;

  constructor(deps: StandardPhaseRunnerDeps) {
    this.deps = deps;
  }

  async run(spec: PhaseSpec, ctx: PhaseRunnerContext): Promise<PhaseIntent> {
    if (spec.kind === 'gate') {
      return this.runGate(spec);
    }

    const phase = createPhase(
      spec.id,
      this.deps.aiRunner,
      this.deps.wtGit,
      this.deps.wtPlan,
      this.deps.config,
    );

    const phaseCtx = this.buildPhaseContext(spec, ctx);
    const callbacks = this.buildCallbacks(spec, ctx);

    return phase.run(phaseCtx, callbacks);
  }


  private runGate(spec: PhaseSpec): PhaseIntent {
    return {
      kind: 'awaitGate',
      reason: this.inferGateReason(spec.id),
    };
  }

  private inferGateReason(phaseId: string): 'human-review' | 'uat-confirm' | 'custom' {
    switch (phaseId) {
      case 'review':
        return 'human-review';
      case 'uat':
        return 'uat-confirm';
      default:
        return 'custom';
    }
  }

  private buildPhaseContext(spec: PhaseSpec, ctx: PhaseRunnerContext): PhaseContext {
    const phaseCtx: PhaseContext = {
      demand: ctx.demand as DemandSpec,
      branchName: ctx.branchName,
      pipelineMode: ctx.pipelineMode,
      workDir: ctx.workDir,
    };

    if (ctx.ports) phaseCtx.ports = ctx.ports as PortPair;
    if (ctx.workspace) phaseCtx.workspace = ctx.workspace as WorkspaceLayout;

    if (spec.id === 'build' && ctx.fixIteration && ctx.fixIteration > 0) {
      phaseCtx.fixContext = {
        iteration: ctx.fixIteration,
        verifyFailures: [...(ctx.verifyFailures ?? [])],
        rawReport: ctx.rawReport ?? '',
      };
    }

    return phaseCtx;
  }

  private buildCallbacks(spec: PhaseSpec, ctx: PhaseRunnerContext): PhaseCallbacks {
    return {
      onStreamEvent: (event: StreamEvent) => {
        this.deps.eventBus.emitTyped('agent:output', {
          issueIid: ctx.issueIid,
          phase: spec.id,
          event,
        });
      },
    };
  }
}
