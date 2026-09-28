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

/**
 * 唯一 Issue 聚合模型。
 *
 * IssueLifecycle 定义工作流状态机；IssueRecord 是状态机的聚合根，
 * 同时持有需求、阶段执行、DAG、运行恢复和交付所需的持久化上下文。
 */
export interface IssueRecord {
  /** 当前业务生命周期；状态变化必须遵守 IssueLifecycle 的合法转换规则。 */
  lifecycle: IssueLifecycle;
  /** 持久化处理锁，防止同一个 Issue 被多个调度协程同时执行。 */
  processingLock?: { correlationId: string; ts: string };
  /** 完整重做或重启后的代数，用于使旧执行身份失效。 */
  resetGeneration?: number;
  /** 当前 Issue 使用的流水线模式，例如 plan-mode。 */
  pipelineMode?: PipelineMode;
  /** 工作分支名称，供 worktree、构建和交付阶段使用。 */
  branchName: string;
  /** 是否为当前 Issue 开启 GitHub 评论同步。 */
  issueNoteSyncEnabled?: boolean;
  /** 为预览服务分配的前后端端口。 */
  ports?: PortPairRecord;
  /** 预览服务启动时间，用于状态展示和资源回收。 */
  previewStartedAt?: string;
  /** 工作流完成时间。 */
  completedAt?: string;
  /** worktree 被清理的时间，用于判断执行目录是否仍然存在。 */
  worktreeCleanedAt?: string;
  /** 已创建或确认的交付 PR 地址。 */
  prUrl?: string;
  /** 交付动作尚未完成，但需要后续恢复处理。 */
  deliveryPending?: boolean;
  /** 最近一次 UAT 执行的唯一 ID。 */
  uatRunId?: string;
  /** 是否已经向 GitHub Issue 写入交付结果评论。 */
  deliveryNoteWritten?: boolean;
  /** 被归档的阶段历史，通常用于重做或重启后保留诊断信息。 */
  archivedPhaseHistory?: PhaseHistoryEntry[];
  /** 本地首次创建该聚合的时间。 */
  createdAt: string;
  /** 本地最近一次修改该聚合的时间。 */
  updatedAt: string;
  /** 需求规格，描述要交付什么，以及它来自哪个外部来源。 */
  demandSpec: DemandSpec;
  /** 每个流水线阶段的状态、时间、错误和可恢复的 AI 会话。 */
  phaseProgress?: Record<string, PhaseProgress>;
  /** DAG 和 Agent 执行上下文，包括计划、任务、调用、重试、验收和交付凭证。 */
  run: IssueRun;
  /** 阶段执行历史，用于审核、重试、诊断和工作台展示。 */
  phaseHistory: PhaseHistoryEntry[];
}

export type NewIssueRecord = Omit<IssueRecord, 'createdAt' | 'updatedAt' | 'run' | 'phaseHistory'> &
  Partial<Pick<IssueRecord, 'run' | 'phaseHistory'>>;

export function lifecyclePhase(lifecycle: IssueLifecycle): PhaseId | undefined {
  return 'phase' in lifecycle ? lifecycle.phase : undefined;
}

export function retryAttempts(record: Pick<IssueRecord, 'run'>): number {
  return Object.values(record.run.retryUsed).reduce((sum, value) => sum + value, 0);
}

export function lifecycleError(lifecycle: IssueLifecycle): string | undefined {
  return lifecycle.kind === 'failed' ? lifecycle.error.message : undefined;
}
