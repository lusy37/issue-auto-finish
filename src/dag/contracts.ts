import { createHash } from 'node:crypto';
import type { DemandSpec } from '../demand/DemandSpec.js';
import { newWorkflowStorage, type WorkflowStorage } from '../orchestration/WorkflowState.js';

import { PLAN_FORMAT } from '../shared/runtime/formats.js';
export { PLAN_FORMAT, RUN_FORMAT } from '../shared/runtime/formats.js';
export interface TaskDefinition {
  /** 任务在当前计划中的稳定标识，用于依赖关系和执行状态关联。 */
  id: string;
  title: string;
  instructions: string;
  /** 只有满足这些条件，任务结果才算完成。 */
  acceptanceCriteria: string[];
  /** 当前任务必须等待完成的前置任务 ID。 */
  dependsOn: string[];
}
export interface PlanContent {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  tasks: TaskDefinition[];
}
export interface TaskPlan extends PlanContent {
  /** 用于识别计划数据格式，避免错误读取旧版本数据。 */
  format: typeof PLAN_FORMAT;
  issueNumber: number;
  /** 同一个 Issue 的计划版本号。 */
  revision: number;
  demand: DemandSpec;
  createdAt: string;
  /** 计划内容摘要，用于检测计划是否被意外修改。 */
  digest: string;
}
export interface ExecutionIdentity {
  issueNumber: number;
  /** 执行所依据的计划版本。 */
  planRevision: number;
  /** 同一计划重新构建时递增，用于隔离不同构建轮次。 */
  buildGeneration: number;
  /** 一次任务调度批次的标识。 */
  dispatchId: string;
  taskId: string;
  /** 同一任务的第几次尝试。 */
  attemptNo: number;
  /** 一次 AI/执行器调用的唯一标识。 */
  callId: string;
}
export interface SuccessReceipt {
  identity: ExecutionIdentity;
  completedAt: string;
  /** 该任务产生的结果提交；无变更时仍记录基线提交。 */
  resultCommit: string;
  noChange: boolean;
  sessionId?: string;
}
export interface MergeReceipt {
  operationId: string;
  stage: 'rebasing' | 'ready' | 'merged';
  preRebaseCommit: string;
  integrationBefore: string;
  postRebaseCommit?: string;
  integrationAfter?: string;
}
export interface TaskRun {
  taskId: string;
  /** 任务当前生命周期状态，uncertain 表示需要恢复或人工确认。 */
  status: 'pending' | 'running' | 'waiting-merge' | 'merging' | 'merged' | 'failed' | 'uncertain';
  attemptNo: number;
  conflictCallsUsed: number;
  identity?: ExecutionIdentity;
  startCommit?: string;
  branch?: string;
  workDir?: string;
  success?: SuccessReceipt;
  merge?: MergeReceipt;
  error?: string;
}
export interface CallRecord {
  identity: ExecutionIdentity;
  workDir: string;
  status: 'queued' | 'running' | 'exited' | 'uncertain';
  pid?: number;
  startedAt?: string;
  exitedAt?: string;
}
export interface AcceptanceReceipt {
  commit: string;
  completedAt: string;
  passed: true;
  reportPath: string;
  runId?: string;
}
export interface DeliveryIdentity {
  repository: string;
  issueNumber: number;
  sourceBranch: string;
  targetBranch: string;
  marker: string;
  prNumber?: number;
  prUrl?: string;
  creation: 'unstarted' | 'unknown' | 'confirmed';
  remoteCommit?: string;
  pushIntent?: { commit: string; lease?: string };
  pushedCommit?: string;
  issueWrittenCommit?: string;
  issueWriteIntent?: { commit: string; marker: string; requestedAt: string };
}
export interface IssueRun {
  /** 工作流节点状态，是运行恢复时的主要入口。 */
  workflow: WorkflowStorage;
  activeCalls?: Record<string, string>;
  budgetHistory?: Array<{ planRevision: number; buildGeneration: number; retryUsed: Record<string, number>; phaseExecutions: Record<string, number>; repairRounds: number }>;
  workspaces?: Array<{ directory: string; branch: string; taskId: string; attemptNo: number; createdAt: string; cleanedAt?: string }>;
  temporaryFiles?: string[];
  installedLockDigest?: string;
  version: number;
  /** 当前运行引用的计划版本及其摘要。 */
  planRevision: number;
  planDigest?: string;
  /** 当前构建轮次，用于区分重新执行或修复。 */
  buildGeneration: number;
  dispatchId?: string;
  stopIntent?: { kind: 'pause' | 'cancel' | 'redo'; requestedAt: string };
  review?: { revision: number; decision: 'waiting' | 'approved' | 'rejected'; feedback?: string; source?: string };
  reviewHistory?: Array<{ round: number; revision: number; feedback: string; timestamp: string; planSnapshot: string; reviewedSessionId?: string }>;
  tasks: Record<string, TaskRun>;
  calls: Record<string, CallRecord>;
  /** 按阶段记录已使用的重试次数，避免超出预算。 */
  retryUsed: Record<string, number>;
  phaseExecutions: Record<string, number>;
  buildEntry: 'execute-graph' | 'repair-integration';
  repairRounds: number;
  repairs: Array<{ round: number; report: string; source: string; before?: string; after?: string; identity?: ExecutionIdentity }>;
  integrationBase?: string;
  integrationHead?: string;
  candidateCommit?: string;
  /** verify 阶段的验收凭证。 */
  verify?: AcceptanceReceipt;
  /** UAT 阶段的验收凭证。 */
  uat?: AcceptanceReceipt;
  /** 交付到目标分支或 PR 的幂等信息。 */
  delivery?: DeliveryIdentity;
  /** 检测到状态无法可靠恢复时置为 true。 */
  recoveryRequired?: boolean;
}
export function newIssueRun(): IssueRun {
  return { workflow: newWorkflowStorage(), version: 0, planRevision: 0, buildGeneration: 0, tasks: {}, calls: {}, retryUsed: {}, phaseExecutions: {}, buildEntry: 'execute-graph', repairRounds: 0, repairs: [] };
}
export function sameIdentity(a: ExecutionIdentity | undefined, b: ExecutionIdentity): boolean {
  return !!a && (Object.keys(b) as Array<keyof ExecutionIdentity>).every(k => a[k] === b[k]);
}
export function planDigest(plan: Omit<TaskPlan, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}
export function renderPlan(plan: PlanContent): string {
  const lines = [`# ${plan.title}`, '', plan.description, '', '## 验收标准', ''];
  lines.push(...plan.acceptanceCriteria.map(criteria => `- ${criteria}`));
  lines.push('', '## 内部任务', '');

  for (const task of plan.tasks) {
    lines.push(
      `### ${task.id}：${task.title}`,
      '',
      `**依赖**：${task.dependsOn.join('、') || '无'}`,
      '',
      '**实施说明**',
      '',
      task.instructions,
      '',
      '**任务验收标准**',
      '',
      ...task.acceptanceCriteria.map(criteria => `- ${criteria}`),
      '',
    );
  }

  return lines.join('\n').trimEnd();
}
