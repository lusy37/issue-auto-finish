import type { PhaseError, GateReason } from './PhaseResult.js';

/** 面向页面和事件的状态投影。执行位置以 LangGraph 检查点为准，不通过此联合类型计算下一节点。 */
export type OrchestrationState =
  | QueuedState
  | RunningState
  | GateWaitingState
  | GateApprovedState
  | PausedState
  | PipelineCompletedState
  | PipelineFailedState
  | ConflictResolvingState;

/** 入队待驱动（取代 Pending / BranchCreated） */
export interface QueuedState {
  readonly kind: 'queued';
}

/** 阶段执行中（取代 PhaseRunning） */
export interface RunningState {
  readonly kind: 'running';
  readonly phaseId: string;
}

/** 阶段等待 gate（取代 PhaseWaiting） */
export interface GateWaitingState {
  readonly kind: 'gate-waiting';
  readonly phaseId: string;
  readonly reason: GateReason;
  readonly payload?: Record<string, unknown>;
}

/** Gate 已批准等待恢复（取代 PhaseApproved） */
export interface GateApprovedState {
  readonly kind: 'gate-approved';
  readonly phaseId: string;
}

/** 用户主动暂停 — 保留 worktree 与会话（取代 Paused） */
export interface PausedState {
  readonly kind: 'paused';
  readonly phaseId: string;
}

/** 流水线全部完成（取代 Completed / Deployed） */
export interface PipelineCompletedState {
  readonly kind: 'pipeline-completed';
}

/** 流水线失败（取代 Failed） */
export interface PipelineFailedState {
  readonly kind: 'pipeline-failed';
  /** 失败发生时的阶段 ID */
  readonly failedAt: string;
  /**
   * 是否可自动重试：
   * - `auto`：下次 drive tick 自动从 failedAt 阶段重试
   * - `manual`：必须用户显式 retry / retry-from
   */
  readonly retryable: 'auto' | 'manual';
  readonly error?: PhaseError;
}

/** Completed 后检测到 PR 冲突，正在解决中（取代 ResolvingConflict） */
export interface ConflictResolvingState {
  readonly kind: 'conflict-resolving';
}

// ---------------------------------------------------------------------------
// 阶段历史记录（持久化在 IssueRecord.phaseHistory）
// ---------------------------------------------------------------------------

/** 阶段历史条目 — 真实事件流水账，主要供前端展示与诊断 */
export interface PhaseHistoryEntry {
  readonly planRevision?: number;
  readonly buildGeneration?: number;
  readonly phaseId: string;
  /** 同一阶段第几次尝试（1-based） */
  readonly attemptId: number;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly outcome: PhaseHistoryOutcome;
  readonly sessionId?: string;
  readonly errorMessage?: string;
  /** 未提供来源的历史审批按人工操作展示。 */
  readonly approvalSource?: 'manual' | 'label' | 'configuration';
  /** verify-fix loop 第几轮（仅适用于 verify 阶段） */
  readonly fixIteration?: number;
  /**
   * retry-from 携带的修复上下文（仅对 outcome='retried-from' 有意义）。
   *
   * 编排器在下一轮调度目标阶段时需要把这些上下文透传给阶段实现，
   * 让 AI 知道前一轮失败的具体原因，避免「黑盒重试」浪费 retry budget。
   *
   * 注：把它放在 history 而不是 RunningState，是因为同一 retry-from 链
   * 可能在 await-async / 中途崩溃后恢复——history 是真实事件流水账，
   * 比瞬态 RunningState 更可靠。
   */
  readonly retryFromContext?: RetryFromContext;
}

/** retry-from 时由 RequestRetryFromIntent.context 提取的修复上下文 */
export interface RetryFromContext {
  /** 触发 retry-from 的失败原因列表（如 verify 报告中的 ['Lint 检查失败', 'Todolist 未全部完成(0/18)']） */
  readonly verifyFailures: readonly string[];
  /** 原始报告内容（如完整的 verify-report.md），用于给 AI 提供详尽诊断材料 */
  readonly rawReport: string;
}

export type PhaseHistoryOutcome =
  | 'completed'
  | 'failed'
  | 'gated'
  | 'gate-approved'
  | 'gate-rejected'
  | 'retried-from'
  | 'paused';

// ---------------------------------------------------------------------------
// Gate 操作（用户对 gate 的统一操作 DTO）
// ---------------------------------------------------------------------------


export type GateAction =
  | { readonly action: 'approve'; readonly source?: 'manual' | 'label' | 'configuration' }
  | { readonly action: 'reject'; readonly feedback: string }
  | { readonly action: 'supplement'; readonly context: string };
