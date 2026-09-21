import type { ExecutableTask, IssueRecord, PhaseStatus, PipelineMeta } from '@/types';

/** 工作台展示使用的阶段摘要。原始任务数据仍然保留，便于详情页继续读取完整契约。 */
export interface WorkbenchRow extends ExecutableTask {
  issueNumber: number;
  statusLabel: string;
  progressPercent: number;
  activePhaseLabel: string;
}

export type AllowedAction =
  | 'start'
  | 'retry'
  | 'abort'
  | 'continue'
  | 'redo-phase'
  | 'restart'
  | 'cancel'
  | 'stop-preview'
  | 'restart-preview';

const PHASE_LABELS: Record<string, string> = {
  plan: '计划',
  review: '审核',
  build: '构建',
  verify: '验证',
  uat: '验收',
  deliver: '交付',
};

function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? phase;
}

function lifecycleLabel(task: ExecutableTask): string {
  const phase = 'phase' in task.lifecycle ? task.lifecycle.phase : undefined;
  if (phase && (task.lifecycle.kind === 'running' || task.lifecycle.kind === 'waiting')) {
    return `${phaseLabel(phase)} · ${task.lifecycle.kind === 'running' ? '执行中' : '等待处理'}`;
  }
  const labels: Record<string, string> = {
    pending: '待启动',
    skipped: '已跳过',
    ready: '准备就绪',
    paused: '已暂停',
    failed: '失败待处理',
    delivering: '交付中',
    completed: '已完成',
    cancelled: '已取消',
  };
  return labels[task.lifecycle.kind] ?? task.lifecycle.kind;
}

function statusWeight(status: PhaseStatus): number {
  if (status === 'completed') return 1;
  if (status === 'in_progress' || status === 'gate_waiting') return 0.5;
  return 0;
}

function activePhaseLabel(task: ExecutableTask): string {
  const phases = task.phaseProgress ?? [];
  const active = phases.find(phase => phase.status === 'in_progress' || phase.status === 'gate_waiting');
  if (active) return active.label;
  const failed = phases.find(phase => phase.status === 'failed');
  if (failed) return `${failed.label} · 失败`;
  if (phases.length > 0 && phases.every(phase => phase.status === 'completed')) return '全部完成';
  return '';
}

export function toWorkbenchRow(task: ExecutableTask): WorkbenchRow {
  const phases = task.phaseProgress ?? [];
  const progressPercent = phases.length === 0
    ? 0
    : Math.round(phases.reduce((sum, phase) => sum + statusWeight(phase.status), 0) / phases.length * 100);
  return {
    ...task,
    issueNumber: Number(task.taskId),
    statusLabel: task.displayLabel ?? lifecycleLabel(task),
    progressPercent,
    activePhaseLabel: activePhaseLabel(task),
  };
}

export function toWorkbenchRows(tasks: ExecutableTask[]): WorkbenchRow[] {
  return tasks.map(toWorkbenchRow);
}

/**
 * 由服务端生命周期和当前运行配置计算操作入口。
 * 页面只消费这个结果，不根据按钮文案自行推断业务状态。
 */
export function getAllowedActions(record: IssueRecord, _meta?: PipelineMeta | null): AllowedAction[] {
  const kind = record.lifecycle.kind;
  const actions: AllowedAction[] = [];
  if (kind === 'skipped') actions.push('start');
  if (kind === 'failed') actions.push('retry');
  if (kind === 'running' || kind === 'waiting' || kind === 'ready') actions.push('abort');
  if (kind === 'paused') actions.push('continue', 'redo-phase');
  if (kind !== 'skipped') actions.push('restart');
  if (record.preview?.running) actions.push('stop-preview');
  else if (!['pending', 'skipped'].includes(kind)) actions.push('restart-preview');
  if (kind !== 'completed' && kind !== 'cancelled') actions.push('cancel');
  return actions;
}

