import type { PhaseIntent } from './Intent.js';
import type { PhaseSpec } from './Pipeline.js';

/**
 * PhaseRunner — 单阶段执行器接口（src/orchestration/* 不依赖 git/tracker/eventBus）。
 *
 * 职责：
 * - 接收 PhaseSpec + 阶段上下文，调用对应阶段的 run() 方法获得 PhaseIntent。
 * - **不**承担副作用（commit / sync / event）—— 这些由 Orchestrator 根据 Reducer 返回的 sideEffects 执行。
 *
 * 具体实现见 src/orchestrator/StandardPhaseRunner.ts（依赖 GitOperations / PlanPersistence / EventBus）。
 */
export interface PhaseRunner {
  run(spec: PhaseSpec, ctx: PhaseRunnerContext): Promise<PhaseIntent>;
}

/** PhaseRunner 执行单阶段时的上下文 */
export interface PhaseRunnerContext {
  readonly issueIid: number;
  /** 需求规格（不依赖具体类型以保持核心模块解耦） */
  readonly demand: unknown;
  readonly branchName: string;
  readonly workDir: string;
  readonly pipelineMode?: string;
  /** 预览端口（不在此模块定义，仅透传） */
  readonly ports?: unknown;
  /** 工作区布局（不在此模块定义，仅透传） */
  readonly workspace?: unknown;
  /** verify-fix loop 的修复上下文（fixIteration 自动推算自历史） */
  readonly fixIteration?: number;
  readonly verifyFailures?: readonly string[];
  readonly rawReport?: string;
}
