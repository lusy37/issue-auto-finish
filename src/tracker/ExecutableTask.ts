import type { IssueRecord } from './IssueState.js';
import type { ActionLifecycleManager } from '../lifecycle/ActionLifecycleManager.js';
import { getIssueNumber, getTitle } from './IssueRecordHelper.js';

/**
 * UnifiedTaskStatus — 所有任务类型共享的通用状态枚举。
 *
 * 与 IssueState/BatchStatus/TaskStatus 共存，不替代它们。
 * 用于跨任务类型的通用逻辑（如统一 dashboard、统一恢复）。
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
 * ExecutableTask — 所有可执行任务的统一接口。
 *
 * IssueRecord 投影为工作台任务接口，
 * 用于跨任务类型的通用操作。
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
  /** 原始状态值（IssueState 或 TaskStatus） */
  readonly sourceState?: string;
  /** 过滤分类：active/completed/failed/blocked/idle/skipped */
  readonly stateCategory?: string;
  /** 预计算的状态展示标签（由后端投影时通过 ActionLifecycleManager.resolveLabel 生成） */
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
 * ActionStatus → UnifiedTaskStatus 映射。
 *
 * 使用 ActionLifecycleManager 的 resolve() 返回的 ActionStatus 做语义映射：
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
 * TaskStatus → UnifiedTaskStatus 映射。
 */
export function taskStatusToUnified(status: string): UnifiedTaskStatus {
  switch (status) {
    case 'pending':
    case 'blocked':
      return 'idle';
    case 'running':
      return 'running';
    case 'done':
      return 'preparing';  // done but not yet merged
    case 'merging':
    case 'conflict_resolving':
      return 'merging';
    case 'merged':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return 'idle';
  }
}

/** 从 UnifiedTaskStatus 派生 stateCategory（用于前端过滤） */
export function unifiedStatusToCategory(status: UnifiedTaskStatus): string {
  switch (status) {
    case 'running':
    case 'preparing':
    case 'merging':
      return 'active';
    case 'waiting':
      return 'blocked';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'idle':
    default:
      return 'idle';
  }
}

/**
 * 为 Issue 计算 stateCategory（精确版，使用 ActionLifecycleManager）。
 * 比 unifiedStatusToCategory 更精准，能区分 skipped 等状态。
 */
export function issueStateCategory(record: IssueRecord, lm: ActionLifecycleManager): string {
  if (lm.isTerminal(record.state)) {
    if (record.state === 'failed') return 'failed';
    if (record.state === 'completed') return 'completed';
    return 'skipped';
  }
  if (lm.isBlocked(record.state)) return 'blocked';
  return 'active';
}

// ── Adapters ──

/** 将 IssueRecord 投影为 ExecutableTask */
export function issueToExecutableTask(
  record: IssueRecord,
  lm: ActionLifecycleManager,
): ExecutableTask {
  const actionState = lm.resolve(record.state, record.currentPhase);

  // 阶段进度快照：优先使用 tracker 中的真实进度，旧记录降级为推导
  const phaseDefs = lm.getPhaseDefs();
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
    const phaseStatusMap = lm.derivePhaseStatuses(record.state, record.currentPhase);
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
    attempts: record.attempts,
    lastError: record.lastError,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    branchName: record.branchName,
    sourceState: record.state,
    stateCategory: issueStateCategory(record, lm),
    displayLabel: lm.resolveLabel(record.state, record.currentPhase),
    phaseProgress,
  };
}
