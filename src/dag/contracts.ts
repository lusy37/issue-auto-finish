import { createHash } from 'node:crypto';
import type { DemandSpec } from '../demand/DemandSpec.js';
import { newWorkflowStorage, type WorkflowStorage } from '../orchestration/WorkflowState.js';

export const PLAN_FORMAT = 'iaf-mini/task-plan/v2' as const;
export const RUN_FORMAT = 'iaf-mini/issue-run/v5-langgraph' as const;
export interface TaskDefinition {
  id: string;
  title: string;
  instructions: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
}
export interface PlanContent {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  tasks: TaskDefinition[];
}
export interface TaskPlan extends PlanContent {
  format: typeof PLAN_FORMAT;
  issueNumber: number;
  revision: number;
  demand: DemandSpec;
  createdAt: string;
  digest: string;
}
export interface ExecutionIdentity {
  issueNumber: number;
  planRevision: number;
  buildGeneration: number;
  dispatchId: string;
  taskId: string;
  attemptNo: number;
  callId: string;
}
export interface SuccessReceipt {
  identity: ExecutionIdentity;
  completedAt: string;
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
  workflow: WorkflowStorage;
  activeCalls?: Record<string, string>;
  budgetHistory?: Array<{ planRevision: number; buildGeneration: number; retryUsed: Record<string, number>; phaseExecutions: Record<string, number>; repairRounds: number }>;
  workspaces?: Array<{ directory: string; branch: string; taskId: string; attemptNo: number; createdAt: string; cleanedAt?: string }>;
  temporaryFiles?: string[];
  installedLockDigest?: string;
  version: number;
  planRevision: number;
  planDigest?: string;
  buildGeneration: number;
  dispatchId?: string;
  stopIntent?: { kind: 'pause' | 'cancel' | 'redo'; requestedAt: string };
  review?: { revision: number; decision: 'waiting' | 'approved' | 'rejected'; feedback?: string; source?: string };
  reviewHistory?: Array<{ round: number; revision: number; feedback: string; timestamp: string; planSnapshot: string; reviewedSessionId?: string }>;
  tasks: Record<string, TaskRun>;
  calls: Record<string, CallRecord>;
  retryUsed: Record<string, number>;
  phaseExecutions: Record<string, number>;
  buildEntry: 'execute-graph' | 'repair-integration';
  repairRounds: number;
  repairs: Array<{ round: number; report: string; source: string; before?: string; after?: string; identity?: ExecutionIdentity }>;
  integrationBase?: string;
  integrationHead?: string;
  candidateCommit?: string;
  verify?: AcceptanceReceipt;
  uat?: AcceptanceReceipt;
  delivery?: DeliveryIdentity;
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
  return [`# ${plan.title}`, plan.description, '## 验收标准', ...plan.acceptanceCriteria.map(c => `- ${c}`), '## 内部任务', ...plan.tasks.flatMap(t => [`### ${t.id}：${t.title}`, `依赖：${t.dependsOn.join('、') || '无'}`, t.instructions, ...t.acceptanceCriteria.map(c => `- ${c}`)])].join('\n\n');
}
