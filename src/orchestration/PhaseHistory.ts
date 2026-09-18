/** 阶段历史条目：真实事件流水账，只用于审计、页面展示和恢复上下文。 */
export interface PhaseHistoryEntry {
  readonly planRevision?: number;
  readonly buildGeneration?: number;
  readonly phaseId: string;
  readonly attemptId: number;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly outcome: PhaseHistoryOutcome;
  readonly sessionId?: string;
  readonly errorMessage?: string;
  readonly approvalSource?: 'manual' | 'label' | 'configuration';
  readonly fixIteration?: number;
  readonly retryFromContext?: RetryFromContext;
}

export interface RetryFromContext {
  readonly verifyFailures: readonly string[];
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

export type GateAction =
  | { readonly action: 'approve'; readonly source?: 'manual' | 'label' | 'configuration' }
  | { readonly action: 'reject'; readonly feedback: string }
  | { readonly action: 'supplement'; readonly context: string };
