import type { PhaseResult } from './PhaseResult.js';
import type { PhaseSpec } from './Phases.js';

/** 单阶段业务执行接口；图负责顺序、重试和人工介入，执行器负责 SDK、Git 与验收凭证。 */
export interface PhaseRunner {
  run(spec: PhaseSpec, ctx: PhaseRunnerContext): Promise<PhaseResult>;
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
  /** 集成修复上下文（fixIteration 来自持久化 repairRounds） */
  readonly fixIteration?: number;
  readonly verifyFailures?: readonly string[];
  readonly rawReport?: string;
}
