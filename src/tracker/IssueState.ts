import type { DemandSpec } from '../demand/DemandSpec.js';
import type { IssueRun } from '../dag/contracts.js';
import type { GateReason, PhaseError } from '../orchestration/PhaseResult.js';
import type { OrchestrationState, PhaseHistoryEntry } from '../orchestration/OrchestrationState.js';

export enum IssueState {
  Pending = 'pending',
  Skipped = 'skipped',
  BranchCreated = 'branch_created',
  // ── 通用阶段状态 ──
  /** AI 阶段执行中（配合 currentPhase 使用） */
  PhaseRunning = 'phase_running',
  /** AI 阶段执行完毕（配合 currentPhase 使用） */
  PhaseDone = 'phase_done',
  /** Gate 阶段等待中（配合 currentPhase 使用） */
  PhaseWaiting = 'phase_waiting',
  /** Gate 阶段已批准（配合 currentPhase 使用） */
  PhaseApproved = 'phase_approved',
  // Conflict resolution (post-completion)
  ResolvingConflict = 'resolving_conflict',
  /** 用户主动中止，保留 worktree/分支/session，可继续或重做 */
  Paused = 'paused',
  // Terminal
  Delivering = 'delivering',
  Cancelled = 'cancelled',
  Completed = 'completed',
  Failed = 'failed',
}

export type PipelineMode = string;

export interface PortPairRecord {
  backendPort: number;
  frontendPort: number;
}

/** 生命周期状态 — 由 IssueTracker 管理 */
export interface IssueLifecycle {
  state: IssueState;
  /** 当 state 为 PhaseRunning/PhaseDone/PhaseWaiting/PhaseApproved 时，记录具体阶段名 */
  currentPhase?: string;
  attempts: number;
  lastError?: string;
  failedAtState?: IssueState;
  /** 最后一次错误是否可重试。未指定时允许重试，仍受次数上限约束 */
  lastErrorRetryable?: boolean;
  /** 中止时的阶段名（Paused 状态下有值） */
  pausedAtPhase?: string;
  /** 持久化处理锁，防止 poller 并发拾取同一 issue；未设置时表示无锁 */
  processingLock?: {
    correlationId: string;
    ts: string;
  };
  /** 每次 resetFull() 递增，用于识别并发重置；尚未重置时按 0 处理 */
  resetGeneration?: number;
}

/** 流水线配置 */
export interface IssuePipeline {
  pipelineMode?: PipelineMode;
}

/** 分支信息 */
export interface IssueBranch {
  branchName: string;
}

/** Issue 级别的功能开关 */
export interface IssueFeatureFlags {
  /** undefined = follow system setting */
  issueNoteSyncEnabled?: boolean;
}

/** 部署/预览信息 */
export interface IssueDeployment {
  /** Allocated ports for preview/E2E (persisted for recovery) */
  ports?: PortPairRecord;
  /** Preview servers started at */
  previewStartedAt?: string;
}

/** Worktree 清理生命周期 */
export interface IssueWorktreeLifecycle {
  /** 进入完成态（Completed）的时间戳；worktree 延迟清理的计时起点 */
  completedAt?: string;
  /** worktree 已被清理的时间戳；存在则 WorktreeReaper 跳过该记录 */
  worktreeCleanedAt?: string;
}

/** 结果信息 */
export interface IssueResult {
  prUrl?: string;
  deliveryPending?: boolean;
  uatRunId?: string;
  deliveryNoteWritten?: boolean;
  retryCount?: number;
  archivedPhaseHistory?: PhaseHistoryEntry[];
}

/** 审计时间戳 */
export interface IssueAudit {
  createdAt: string;
  updatedAt: string;
}

/** 需求规格（知识域），新建 Issue 时填充 */
export interface IssueDemand {
  demandSpec?: DemandSpec;
}

/** 阶段进度（真实事件记录，非推导） */
export interface IssuePhaseProgress {
  /** 各阶段的实际进度记录，key 为阶段名 */
  phaseProgress?: Record<string, PhaseProgress>;
}


export interface IssueOrchestration {
  run?: IssueRun;

  orchestrationState?: OrchestrationState;
  /** 阶段执行历史流水账，用于 Reducer 决策与前端展示 */
  phaseHistory?: PhaseHistoryEntry[];
}


export type IssueRecord =
  IssueLifecycle &
  IssuePipeline &
  IssueBranch &
  IssueFeatureFlags &
  IssueDeployment &
  IssueWorktreeLifecycle &
  IssueResult &
  IssueDemand &
  IssueAudit &
  IssuePhaseProgress &
  IssueOrchestration;

export type PhaseStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'gate_waiting';

export interface PhaseProgress {
  status: PhaseStatus;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  /** AI 会话 ID，用于通过 Runner 恢复执行 */
  sessionId?: string;
}

export interface ProgressData {
  displayId: number;
  title: string;
  branchName: string;
  pipelineMode?: PipelineMode;
  currentPhase: string;
  phases: Record<string, PhaseProgress>;
}


export function deriveOrchestrationState(record: IssueRecord): OrchestrationState {
  const phaseId = record.currentPhase ?? '';

  switch (record.state) {
    case IssueState.Pending:
    case IssueState.BranchCreated:
      return { kind: 'queued' };

    case IssueState.PhaseRunning:
      return { kind: 'running', phaseId };

    case IssueState.PhaseDone:
      return { kind: 'gate-approved', phaseId };

    case IssueState.PhaseWaiting:
      return { kind: 'gate-waiting', phaseId, reason: deriveGateReason(phaseId) };

    case IssueState.PhaseApproved:
      return { kind: 'gate-approved', phaseId };

    case IssueState.Paused:
      return { kind: 'paused', phaseId: record.pausedAtPhase ?? phaseId };

    case IssueState.ResolvingConflict:
      return { kind: 'conflict-resolving' };

    case IssueState.Delivering:
    case IssueState.Cancelled:
    case IssueState.Completed:
    case IssueState.Skipped:
      return { kind: 'pipeline-completed' };

    case IssueState.Failed:
      return deriveFailedState(record);
  }
}


function deriveGateReason(phaseId: string): GateReason {
  switch (phaseId) {
    case 'review':
      return 'human-review';
    case 'uat':
      return 'uat-confirm';
    default:
      return 'custom';
  }
}

function deriveFailedState(record: IssueRecord): OrchestrationState {
  const failedAt = record.currentPhase ?? '';
  const retryable: 'auto' | 'manual' = record.lastErrorRetryable === false ? 'manual' : 'auto';
  const error: PhaseError | undefined = record.lastError
    ? {
        message: record.lastError,
        retryable: record.lastErrorRetryable === false ? 'hard-no-auto' : 'hard',
      }
    : undefined;
  return { kind: 'pipeline-failed', failedAt, retryable, error };
}
