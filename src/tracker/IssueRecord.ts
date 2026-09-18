import type { DemandSpec } from '../demand/DemandSpec.js';
import type { IssueRun } from '../dag/contracts.js';
import type { PhaseHistoryEntry } from '../orchestration/PhaseHistory.js';
import type { PhaseId } from '../orchestration/WorkflowState.js';
import type { IssueLifecycle } from './IssueLifecycle.js';

export type PipelineMode = string;
export type PhaseStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'gate_waiting';

export interface PortPairRecord {
  backendPort: number;
  frontendPort: number;
}

export interface PhaseProgress {
  status: PhaseStatus;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  /** AI 会话 ID，用于通过 Runner 恢复执行。 */
  sessionId?: string;
}

/** Native 的唯一 Issue 聚合模型，不保存旧状态枚举及其反向适配字段。 */
export interface IssueRecord {
  lifecycle: IssueLifecycle;
  processingLock?: { correlationId: string; ts: string };
  resetGeneration?: number;
  pipelineMode?: PipelineMode;
  branchName: string;
  issueNoteSyncEnabled?: boolean;
  ports?: PortPairRecord;
  previewStartedAt?: string;
  completedAt?: string;
  worktreeCleanedAt?: string;
  prUrl?: string;
  deliveryPending?: boolean;
  uatRunId?: string;
  deliveryNoteWritten?: boolean;
  archivedPhaseHistory?: PhaseHistoryEntry[];
  createdAt: string;
  updatedAt: string;
  demandSpec: DemandSpec;
  phaseProgress?: Record<string, PhaseProgress>;
  run: IssueRun;
  phaseHistory: PhaseHistoryEntry[];
}

export type NewIssueRecord = Omit<IssueRecord, 'createdAt' | 'updatedAt' | 'run' | 'phaseHistory'>
  & Partial<Pick<IssueRecord, 'run' | 'phaseHistory'>>;

export function lifecyclePhase(lifecycle: IssueLifecycle): PhaseId | undefined {
  return 'phase' in lifecycle ? lifecycle.phase : undefined;
}

export function retryAttempts(record: Pick<IssueRecord, 'run'>): number {
  return Object.values(record.run.retryUsed).reduce((sum, value) => sum + value, 0);
}

export function lifecycleError(lifecycle: IssueLifecycle): string | undefined {
  return lifecycle.kind === 'failed' ? lifecycle.error.message : undefined;
}
