import { lifecycleError, retryAttempts, type IssueRecord } from './IssueRecord.js';
import type { PipelineDef } from '../pipeline/PipelineMetadata.js';
import {
  projectLifecycleAction,
  projectLifecycleLabel,
  projectLifecyclePhaseStatuses,
} from '../pipeline/PipelineProjection.js';
import { getIssueNumber, getTitle } from './IssueRecordHelper.js';

import type { ExecutableTask, UnifiedTaskStatus } from '../shared/workbench.js';
export type { ExecutableTask, UnifiedTaskStatus } from '../shared/workbench.js';

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
export function issueToExecutableTask(record: IssueRecord, def: PipelineDef): ExecutableTask {
  const lifecycle = record.lifecycle;
  const actionState = projectLifecycleAction(lifecycle);

  // 阶段进度快照：使用已持久化的进度；尚未初始化进度时由任务状态推导
  const phaseDefs = def.phases.map((phase) => ({ name: phase.name, label: phase.label }));
  let phaseProgress: ExecutableTask['phaseProgress'];
  if (record.phaseProgress) {
    phaseProgress = phaseDefs.map((p) => ({
      name: p.name,
      label: p.label,
      status: record.phaseProgress![p.name]?.status ?? ('pending' as const),
      startedAt: record.phaseProgress![p.name]?.startedAt,
      completedAt: record.phaseProgress![p.name]?.completedAt,
    }));
  } else {
    const phaseStatusMap = projectLifecyclePhaseStatuses(def, lifecycle);
    phaseProgress = phaseDefs.map((p) => ({
      name: p.name,
      label: p.label,
      status: phaseStatusMap[p.name] ?? ('pending' as const),
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
