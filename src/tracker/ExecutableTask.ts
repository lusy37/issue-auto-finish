import { lifecycleError, retryAttempts, type IssueRecord } from './IssueRecord.js';
import type { IssueLifecycle } from './IssueLifecycle.js';
import type { PipelineDef } from '../pipeline/PipelineMetadata.js';
import {
  projectLifecycleAction,
  projectLifecycleLabel,
  projectLifecyclePhaseStatuses,
} from '../pipeline/PipelineProjection.js';
import { getIssueNumber, getTitle } from './IssueRecordHelper.js';

/**
 * 工作台展示使用的任务状态，由当前 Issue 生命周期投影。
 */
export type UnifiedTaskStatus =
  | 'idle'          // 尚未开始
  | 'preparing'     // 准备中（创建分支、安装依赖等）
  | 'running'       // 执行中
  | 'waiting'       // 等待外部输入（审核等）
  | 'merging'       // 合并中
  | 'completed'     // 完成
  | 'failed';       // 失败

/**
 * IssueRecord 投影为工作台列表和详情使用的任务接口。
 */
export interface ExecutableTask {
  /** 任务类型标识 */
  readonly kind: 'issue';
  /** 唯一标识（string(issueIid)） */
  readonly taskId: string;
  /** 显示标题 */
  readonly title: string;
  /** 统一状态 */
  readonly status: UnifiedTaskStatus;
  /** 重试次数 */
  readonly attempts: number;
  /** 最后错误 */
  readonly lastError?: string;
  /** 创建时间 */
  readonly createdAt: string;
  /** 最后更新时间 */
  readonly updatedAt: string;
  /** 特性分支名 */
  readonly branchName?: string;
  /** 当前业务生命周期。 */
  readonly lifecycle: IssueLifecycle;
  /** 过滤分类：active/completed/failed/blocked/idle/skipped */
  readonly stateCategory?: string;
  /** 预计算的状态展示标签 */
  readonly displayLabel?: string;

  /** 阶段进度快照（由后端投影时预计算）。
   *  各阶段按定义顺序排列，包含真实事件时间戳。
   *  未提供时前端不渲染阶段进度列。 */
  readonly phaseProgress?: {
    name: string;
    label: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'gate_waiting';
    startedAt?: string;
    completedAt?: string;
  }[];
}

/**
 * 页面动作状态 → UnifiedTaskStatus 映射。
 * - idle/skipped → 'idle'
 * - ready → 'preparing'
 * - running → 'running'
 * - waiting → 'waiting'
 * - done → 'completed'
 * - failed → 'failed'
 */
export function issueStateToUnified(actionStatus: string): UnifiedTaskStatus {
  switch (actionStatus) {
    case 'idle':
    case 'skipped':
      return 'idle';
    case 'ready':
      return 'preparing';
    case 'running':
      return 'running';
    case 'waiting':
      return 'waiting';
    case 'done':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return 'idle';
  }
}

/**
 * 根据 Issue 生命周期计算工作台过滤分类，区分完成、失败、跳过和等待。
 */
export function issueStateCategory(record: IssueRecord): string {
  const lifecycle = record.lifecycle;
  if (lifecycle.kind === 'failed') return 'failed';
  if (lifecycle.kind === 'completed') return 'completed';
  if (lifecycle.kind === 'skipped' || lifecycle.kind === 'cancelled') return 'skipped';
  if (lifecycle.kind === 'waiting' || lifecycle.kind === 'paused') return 'blocked';
  return 'active';
}

// ── Adapters ──

/** 将 IssueRecord 投影为 ExecutableTask */
export function issueToExecutableTask(
  record: IssueRecord,
  def: PipelineDef,
): ExecutableTask {
  const lifecycle = record.lifecycle;
  const actionState = projectLifecycleAction(lifecycle);

  // 阶段进度快照：使用已持久化的进度；尚未初始化进度时由任务状态推导
  const phaseDefs = def.phases.map(phase => ({ name: phase.name, label: phase.label }));
  let phaseProgress: ExecutableTask['phaseProgress'];
  if (record.phaseProgress) {
    phaseProgress = phaseDefs.map(p => ({
      name: p.name,
      label: p.label,
      status: record.phaseProgress![p.name]?.status ?? 'pending' as const,
      startedAt: record.phaseProgress![p.name]?.startedAt,
      completedAt: record.phaseProgress![p.name]?.completedAt,
    }));
  } else {
    const phaseStatusMap = projectLifecyclePhaseStatuses(def, lifecycle);
    phaseProgress = phaseDefs.map(p => ({
      name: p.name,
      label: p.label,
      status: phaseStatusMap[p.name] ?? 'pending' as const,
    }));
  }

  return {
    kind: 'issue',
    taskId: String(getIssueNumber(record)),
    title: getTitle(record),
    status: issueStateToUnified(actionState.status),
    attempts: retryAttempts(record),
    lastError: lifecycleError(lifecycle),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    branchName: record.branchName,
    lifecycle,
    stateCategory: issueStateCategory(record),
    displayLabel: projectLifecycleLabel(lifecycle),
    phaseProgress,
  };
}
