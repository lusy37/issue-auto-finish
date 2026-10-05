import type { IssueRecord as StoredIssueRecord, PhaseStatus as StoredPhaseStatus } from '../../../../shared/workbench';
export type { IssueLifecycle, PhaseProgress, ExecutableTask, UnifiedTaskStatus } from '../../../../shared/workbench';

export type PipelineMode = string;

/** 暂停由生命周期派生，属于前端展示状态。 */
export type PhaseStatus = StoredPhaseStatus | 'paused';

/** 复用聚合契约，只补充服务端提供的展示字段。 */
export interface IssueRecord extends StoredIssueRecord {
  preview?: { running: boolean; previewUrl?: string };
  worktree?: { exists: boolean; cleanedAt?: string; path?: string };
  stateCategory?: string;
  /** 服务端按本轮阶段要求计算出的可查看计划产物。 */
  planDocs?: PlanFileSpec[];
}

export const getIssueIid = (r: IssueRecord): number => Number(r.demandSpec.sourceRef.displayId);
export const getIssueTitle = (r: IssueRecord): string => r.demandSpec.title;
export interface AgentLogEntry {
  identity?: import('../../../../shared/workbench').ExecutionIdentity;
  type: string;
  phase?: string;
  timestamp: string;
  summary: string;
}

export interface SystemStatus {
  uptime: number;
  startedAt: string;
  config: {
    discoveryIntervalMs: number;
    driveIntervalMs: number;
    maxRetries: number;
    aiMaxConcurrency: number;
    aiPhaseTimeoutMs: number;
    aiMode: string;
    aiModel: string;
    maxConcurrent: number;
    pipelineMode: PipelineMode;
    baseBranch: string;
    repository: string;
    githubBaseUrl: string;
    issueNoteSyncEnabled: boolean;
    e2eEnabled: boolean;
    previewEnabled: boolean;
    knowledgeEnabled: boolean;
    distillEnabled: boolean;
    reviewEnabled: boolean;
    verifyFixLoopEnabled: boolean;
    verifyFixMaxIterations: number;
    worktreeCleanupEnabled?: boolean;
    worktreeRetentionMs?: number;
  };
  issues: {
    total: number;
    active: number;
  };
  worktreeReaper?: {
    running: boolean;
    enabled: boolean;
    lastScanAt?: string;
    totalReaped: number;
    intervalMs: number;
    retentionMs: number;
  } | null;
}

export interface SupplementInfo {
  requirements: string;
  acceptanceCriteria: string;
  scope: string;
  constraints: string;
  references: string;
  freeText: string;
}

export interface PlanFileSpec {
  file: string;
  label: string;
}
