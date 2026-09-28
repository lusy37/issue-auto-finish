import { t } from '../i18n/index.js';
import type { IssueLifecycle } from '../tracker/IssueLifecycle.js';
import type { PhaseStatus } from '../tracker/IssueRecord.js';
import type { PipelineDef, PhaseSpec, PlanFileSpec } from './PipelineMetadata.js';

export type DisplayActionStatus =
  | 'idle'
  | 'ready'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'paused';

export interface DisplayAction {
  action: string;
  status: DisplayActionStatus;
}

/** Pipeline 静态查询，不参与 Issue 生命周期推进。 */
export function getRetryablePhases(def: PipelineDef): string[] {
  return def.phases.filter((spec) => spec.retryable ?? spec.kind === 'ai').map((spec) => spec.name);
}

export function isRetryablePhase(def: PipelineDef, phaseName: string): boolean {
  const spec = def.phases.find((phase) => phase.name === phaseName);
  return !!spec && (spec.retryable ?? spec.kind === 'ai');
}

export function getGatePhase(def: PipelineDef): PhaseSpec | undefined {
  return def.phases.find((phase) => phase.kind === 'gate');
}

export function collectPipelineArtifacts(def: PipelineDef): PlanFileSpec[] {
  return def.phases.flatMap((phase) => phase.artifacts ?? []);
}

/** 唯一业务生命周期到页面动作的单向投影。 */
export function projectLifecycleAction(lifecycle: IssueLifecycle): DisplayAction {
  switch (lifecycle.kind) {
    case 'pending':
      return { action: 'init', status: 'idle' };
    case 'skipped':
      return { action: 'init', status: 'skipped' };
    case 'ready':
      return { action: 'init', status: 'ready' };
    case 'running':
      return { action: lifecycle.phase, status: 'running' };
    case 'waiting':
      return { action: lifecycle.phase, status: 'waiting' };
    case 'paused':
      return { action: lifecycle.phase, status: 'paused' };
    case 'failed':
      return { action: lifecycle.phase ?? 'init', status: 'failed' };
    case 'delivering':
      return { action: 'delivery', status: 'ready' };
    case 'completed':
      return { action: 'delivery', status: 'done' };
    case 'cancelled':
      return { action: 'cancel', status: 'skipped' };
  }
}

export function projectLifecycleLabel(lifecycle: IssueLifecycle): string {
  if ('phase' in lifecycle && lifecycle.phase) {
    const label = t(`pipeline.phase.${lifecycle.phase}`);
    switch (lifecycle.kind) {
      case 'running':
        return t('state.phaseDoing', { label });
      case 'waiting':
        return t('state.phaseWaiting', { label });
      case 'paused':
        return t('state.paused');
      case 'failed':
        return t('state.failed');
    }
  }
  switch (lifecycle.kind) {
    case 'pending':
      return t('state.pending');
    case 'skipped':
      return t('state.skipped');
    case 'ready':
      return t('state.branchCreated');
    case 'delivering':
      return '正在交付';
    case 'completed':
      return t('state.completed');
    case 'cancelled':
      return '已取消';
    case 'failed':
      return t('state.failed');
  }
}

function allPending(def: PipelineDef): Record<string, PhaseStatus> {
  return Object.fromEntries(def.phases.map((phase) => [phase.name, 'pending']));
}

function statusesAtPhase(
  def: PipelineDef,
  phaseName: string,
  current: PhaseStatus,
): Record<string, PhaseStatus> {
  const result: Record<string, PhaseStatus> = {};
  let reached = false;
  for (const phase of def.phases) {
    if (reached) result[phase.name] = 'pending';
    else if (phase.name === phaseName) {
      result[phase.name] = current;
      reached = true;
    } else result[phase.name] = 'completed';
  }
  return reached ? result : allPending(def);
}

/** phaseProgress 尚未初始化时的只读页面回退，不用于恢复或调度。 */
export function projectLifecyclePhaseStatuses(
  def: PipelineDef,
  lifecycle: IssueLifecycle,
): Record<string, PhaseStatus> {
  switch (lifecycle.kind) {
    case 'running':
      return statusesAtPhase(def, lifecycle.phase, 'in_progress');
    case 'waiting':
      return statusesAtPhase(def, lifecycle.phase, 'gate_waiting');
    case 'paused':
      return statusesAtPhase(def, lifecycle.phase, 'in_progress');
    case 'failed':
      return lifecycle.phase ? statusesAtPhase(def, lifecycle.phase, 'failed') : allPending(def);
    case 'completed':
      return Object.fromEntries(def.phases.map((phase) => [phase.name, 'completed']));
    default:
      return allPending(def);
  }
}
