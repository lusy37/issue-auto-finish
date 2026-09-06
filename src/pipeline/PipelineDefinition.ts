import { IssueState } from '../tracker/IssueState.js';
import { ActionLifecycleManager } from '../lifecycle/ActionLifecycleManager.js';
import { PipelineNotFoundError } from '../errors/index.js';
import { t } from '../i18n/index.js';
import { getPlanModePhases } from '../orchestration/Pipeline.js';

export type PipelineMode = string;
export type KnownPipelineMode = 'plan-mode';

export interface PhaseSpec {
  name: string;
  label: string;
  startState: IssueState;
  doneState: IssueState;
  kind: 'ai' | 'gate';
  approvedState?: IssueState;
  /** 此阶段是否可被用户单独重试。默认：kind === 'ai' */
  retryable?: boolean;
  /** 此阶段完成后是否应启动预览服务器。默认：false */
  deploysPreview?: boolean;
  /** 此阶段产出的文件列表。默认：[] */
  artifacts?: PlanFileSpec[];
}

export interface PlanFileSpec {
  filename: string;
  label: string;
  editable: boolean;
}

export interface PipelineDef {
  mode: PipelineMode;
  phases: PhaseSpec[];
}

// ---------------------------------------------------------------------------
// Pipeline Registry
// ---------------------------------------------------------------------------

const pipelineRegistry = new Map<string, PipelineDef>();

/**
 * 注册流水线元数据；阶段执行器由执行层独立管理。
 * 重复注册同一 mode 会覆盖。
 */
export function registerPipeline(def: PipelineDef): void {
  pipelineRegistry.set(def.mode, def);
}

/** 获取所有已注册的流水线模式名 */
export function getRegisteredModes(): string[] {
  return [...pipelineRegistry.keys()];
}

/** 获取所有已注册的 PipelineDef */
export function getAllPipelineDefs(): PipelineDef[] {
  return [...pipelineRegistry.values()];
}

/** 用于测试隔离：重置注册表并重新注册内置流水线 */
export function _resetPipelineRegistry(): void {
  pipelineRegistry.clear();
  pipelineRegistry.set(PLAN_MODE_PIPELINE.mode, PLAN_MODE_PIPELINE);
}

// ---------------------------------------------------------------------------
// Built-in pipeline definitions
// ---------------------------------------------------------------------------

export const PLAN_MODE_PIPELINE = buildPlanModePipeline({ e2eEnabled: false });

// Self-register built-in pipelines
pipelineRegistry.set(PLAN_MODE_PIPELINE.mode, PLAN_MODE_PIPELINE);

// ---------------------------------------------------------------------------
// Dynamic pipeline builder
// ---------------------------------------------------------------------------

/**
 * 根据配置动态构建 plan-mode 流水线。
 * 在验证后追加真实浏览器验收阶段。
 */
export function buildPlanModePipeline(opts: { e2eEnabled: boolean }): PipelineDef {
  const specs = getPlanModePhases(opts.e2eEnabled);
  // 状态字段只在任务展示与生命周期层派生，阶段内容统一由编排核心提供。
  const phases: PhaseSpec[] = specs.map((spec, index) => ({
    name: spec.id,
    label: spec.label,
    kind: spec.kind,
    startState: spec.kind === 'gate' ? IssueState.PhaseWaiting : IssueState.PhaseRunning,
    doneState: spec.kind === 'gate'
      ? IssueState.PhaseApproved
      : index === specs.length - 1 ? IssueState.Completed : IssueState.PhaseDone,
    ...(spec.kind === 'gate' ? { approvedState: IssueState.PhaseApproved } : {}),
    ...(spec.retryable !== undefined ? { retryable: spec.retryable } : {}),
    ...(spec.deploysPreview !== undefined ? { deploysPreview: spec.deploysPreview } : {}),
    ...(spec.artifacts ? { artifacts: spec.artifacts.map(artifact => ({ ...artifact })) } : {}),
  }));
  return { mode: 'plan-mode', phases };
}

// ---------------------------------------------------------------------------
// Lookup functions
// ---------------------------------------------------------------------------

export function resolvePipelineMode(explicit?: string): PipelineMode {
  if (explicit && pipelineRegistry.has(explicit)) return explicit;
  return 'plan-mode';
}

export function getPipelineDef(mode: PipelineMode): PipelineDef {
  const def = pipelineRegistry.get(mode);
  if (!def) {
    throw new PipelineNotFoundError(mode);
  }
  return def;
}

/**
 * 从 PipelineDef 创建 ActionLifecycleManager 实例。
 */
export function createLifecycleManager(def: PipelineDef): ActionLifecycleManager {
  return new ActionLifecycleManager(def);
}

export function getPhaseLabel(phaseName: string): string {
  return t(`pipeline.phase.${phaseName}`);
}

export function getPlanFileLabel(filename: string): string {
  return t(`planFile.${filename}`);
}
