import type {IssueLifecycle} from '../../../../shared/workbench';
import type { PhaseHistoryEntry } from '../../../../shared/workbench';
export type {IssueLifecycle} from '../../../../shared/workbench';

export type PipelineMode = string;

export type PhaseStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'paused' | 'gate_waiting';

export interface IssueRecord {
  run?: import('../../../../shared/workbench').IssueRun;
  lifecycle: IssueLifecycle;
  branchName: string;
  sessionId?: string;
  pipelineMode?: PipelineMode;
  prUrl?: string;
  issueNoteSyncEnabled?: boolean;
  demandSpec: {
    demandId: string;
    sourceRef: { source: string; externalId: string; displayId?: string };
    title: string;
    description: string;
  };
  previewStartedAt?: string;
  preview?: { running: boolean; previewUrl?: string };
  worktree?: { exists: boolean; cleanedAt?: string; path?: string };
  createdAt: string;
  updatedAt: string;
  /** tracker 中的真实阶段进度（单一数据源） */
  phaseProgress?: Record<string, PhaseProgress>;
  phaseHistory?: PhaseHistoryEntry[];
  stateCategory?: string;
  /** 服务端按本轮阶段要求计算出的可查看计划产物。 */
  planDocs?: PlanFileSpec[];
}

export const getIssueIid = (r: IssueRecord): number => Number(r.demandSpec.sourceRef.displayId);
export const getIssueTitle = (r: IssueRecord): string => r.demandSpec.title;
export const getReviewApprovalSource = (r: IssueRecord) => r.phaseHistory?.slice().reverse()
  .find(entry => entry.phaseId === 'review' && entry.outcome === 'gate-approved')?.approvalSource;

export interface PhaseProgress {
  status: PhaseStatus;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

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
    aiMode: string;
    pipelineMode: PipelineMode;
    baseBranch: string;
    repository: string;
    githubBaseUrl: string;
    issueNoteSyncEnabled: boolean;
    e2eEnabled: boolean;
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

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  description?: string;
  labels: string[];
  author?: { name?: string; username?: string };
  created_at: string;
}

export interface SupplementInfo {
  requirements: string;
  acceptanceCriteria: string;
  scope: string;
  constraints: string;
  references: string;
  freeText: string;
}

export interface ReviewRound {
  round: number;
  feedback: string;
  timestamp: string;
}

export interface PhaseSpec {
  name: string;
  label: string;
}

export interface PlanFileSpec {
  file: string;
  label: string;
}

// Knowledge types
export type KnowledgeEntryType = 'project-meta' | 'custom' | 'memory' | 'agent-rule';


export interface KnowledgeEntryMeta {
  id: string;
  type: KnowledgeEntryType;
  title: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeEntry extends KnowledgeEntryMeta {
  content: string;
}

export interface KnowledgeStats {
  total: number;
  byType: Record<KnowledgeEntryType, number>;
  lastAnalyzedAt?: string;
}

// Pipeline Meta types (from GET /api/pipeline-meta)

export interface PipelineModeMeta {
  phases: { name: string; label: string; kind: 'ai' | 'gate' }[];
  artifacts: { filename: string; label: string; editable: boolean }[];
  retryablePhases: string[];
}

export interface PipelineMeta {
  modes: Record<PipelineMode, PipelineModeMeta>;
}

// ── 统一任务模型 ──

export type UnifiedTaskStatus =
  | 'idle' | 'preparing' | 'running' | 'waiting'
  | 'merging' | 'completed' | 'failed';

export type TaskKind = 'issue';

export interface ExecutableTask {
  kind: TaskKind;
  taskId: string;
  title: string;
  status: UnifiedTaskStatus;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  branchName?: string;
  lifecycle: IssueLifecycle;
  stateCategory?: string;
  displayLabel?: string;
  phaseProgress?: { name: string; label: string; status: PhaseStatus; startedAt?: string; completedAt?: string }[];
}

// ── Distill (知识蒸馏) ──

export interface DiaryPhaseTiming {
  phase: string;
  durationMs: number;
  retries: number;
}

export interface DiaryTiming {
  totalDurationMs: number;
  phaseTimings: DiaryPhaseTiming[];
  startedAt: string;
  finishedAt: string;
}

export interface DiaryFailure {
  failedAtPhase: string;
  error: string;
  attempts: number;
}

export interface DiaryHumanIntervention {
  type: 'review-approve' | 'review-reject' | 'retry' | 'supplement';
  detail: string;
  timestamp: string;
}

export interface DiaryEntry {
  id: string;
  issueIid: number;
  issueTitle: string;
  branchName: string;
  pipelineMode: string;
  outcome: 'completed' | 'failed';
  prUrl?: string;
  timing: DiaryTiming;
  failure?: DiaryFailure;
  humanInterventions: DiaryHumanIntervention[];
  artifactSummary?: string;
  distilled: boolean;
  createdAt: string;
}

export interface DistillStatus {
  enabled: boolean;
  lastRunAt?: string;
  diaryCount: number;
  undistilledDiaryCount: number;
  memoryCount: number;
  ruleCount: number;
}
