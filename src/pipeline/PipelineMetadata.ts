import { t } from '../i18n/index.js';
import {
  getPlanModePhases,
  type PhaseSpec as ExecutionPhaseSpec,
  type ArtifactSpec,
} from '../orchestration/Phases.js';

export type PipelineMode = 'plan-mode';

/** 展示层沿用 name 命名，其余字段与执行层共用定义。 */
export type PhaseSpec = {
  -readonly [Key in keyof Omit<ExecutionPhaseSpec, 'id' | 'artifacts'>]: ExecutionPhaseSpec[Key];
} & { name: string; artifacts?: PlanFileSpec[] };
export type PlanFileSpec = { -readonly [Key in keyof ArtifactSpec]: ArtifactSpec[Key] };

export interface PipelineDef {
  mode: PipelineMode;
  phases: PhaseSpec[];
}

/** 根据配置构建唯一的 plan-mode 流水线。 */
export function buildPlanModePipeline(opts: { e2eEnabled: boolean }): PipelineDef {
  const phases = getPlanModePhases(opts.e2eEnabled).map(({ id, artifacts, ...metadata }) => ({
    name: id,
    ...metadata,
    ...(artifacts ? { artifacts: artifacts.map((artifact) => ({ ...artifact })) } : {}),
  }));
  return { mode: 'plan-mode', phases };
}

export const PLAN_MODE_PIPELINE = buildPlanModePipeline({ e2eEnabled: false });

export function getPhaseLabel(phaseName: string): string {
  return t(`pipeline.phase.${phaseName}`);
}

export function getPlanFileLabel(filename: string): string {
  return t(`planFile.${filename}`);
}
