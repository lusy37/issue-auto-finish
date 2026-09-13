import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DemandSpec } from '../demand/DemandSpec.js';
import { newWorkflowStorage, workflowStorageSchema, type WorkflowStorage } from '../orchestration/WorkflowState.js';

export const PLAN_FORMAT = 'iaf-mini/task-plan/v2' as const;
export const RUN_FORMAT = 'iaf-mini/issue-run/v3-langgraph' as const;
export const taskPlanInput = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
  tasks: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/),
    title: z.string().trim().min(1),
    instructions: z.string().trim().min(1),
    acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
    dependsOn: z.array(z.string()).max(19),
  }).strict()).min(1).max(20),
}).strict();
export type PlanContent = z.infer<typeof taskPlanInput>;
export type TaskDefinition = PlanContent['tasks'][number];
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
export function validatePlan(value: unknown): PlanContent {
  const parsed = taskPlanInput.parse(value);
  const tasks = new Map(parsed.tasks.map(t => [t.id, t]));
  if (tasks.size !== parsed.tasks.length) throw new Error('任务 ID 重复');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`任务图存在循环：${id}`);
    if (visited.has(id)) return;
    const task = tasks.get(id);
    if (!task) throw new Error(`依赖引用了不存在的任务：${id}`);
    if (new Set(task.dependsOn).size !== task.dependsOn.length) throw new Error(`任务 ${id} 的依赖重复`);
    visiting.add(id);
    task.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  tasks.forEach(t => visit(t.id));
  return parsed;
}
export function planDigest(plan: Omit<TaskPlan, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}
export function renderPlan(plan: PlanContent): string {
  return [`# ${plan.title}`, plan.description, '## 验收标准', ...plan.acceptanceCriteria.map(c => `- ${c}`), '## 内部任务', ...plan.tasks.flatMap(t => [`### ${t.id}：${t.title}`, `依赖：${t.dependsOn.join('、') || '无'}`, t.instructions, ...t.acceptanceCriteria.map(c => `- ${c}`)])].join('\n\n');
}

const counter = z.number().int().nonnegative();
const text = z.string().min(1);
const identitySchema = z.object({ issueNumber: z.number().int().positive(), planRevision: counter, buildGeneration: counter, dispatchId: text, taskId: text, attemptNo: counter, callId: text });
const successSchema = z.object({ identity: identitySchema, completedAt: text, resultCommit: text, noChange: z.boolean(), sessionId: text.optional() });
const mergeSchema = z.object({ operationId: text, stage: z.enum(['rebasing', 'ready', 'merged']), preRebaseCommit: text, integrationBefore: text, postRebaseCommit: text.optional(), integrationAfter: text.optional() });
const taskSchema = z.object({ taskId: text, status: z.enum(['pending', 'running', 'waiting-merge', 'merging', 'merged', 'failed', 'uncertain']), attemptNo: counter, conflictCallsUsed: counter.max(2), identity: identitySchema.optional(), startCommit: text.optional(), branch: text.optional(), workDir: text.optional(), success: successSchema.optional(), merge: mergeSchema.optional(), error: z.string().optional() });
const receiptSchema = z.object({ commit: text, completedAt: text, passed: z.literal(true), reportPath: text, runId: text.optional() });
const runSchema = z.object({
  workflow: workflowStorageSchema,
  version: counter, planRevision: counter, planDigest: text.optional(), buildGeneration: counter, dispatchId: text.optional(),
  stopIntent: z.object({ kind: z.enum(['pause', 'cancel', 'redo']), requestedAt: text }).optional(),
  review: z.object({ revision: counter, decision: z.enum(['waiting', 'approved', 'rejected']), feedback: z.string().optional(), source: z.string().optional() }).optional(),
  activeCalls: z.record(z.string(), text).optional(),
  reviewHistory: z.array(z.object({ round: counter, revision: counter, feedback: z.string(), timestamp: text, planSnapshot: z.string(), reviewedSessionId: text.optional() })).optional(),
  budgetHistory: z.array(z.object({ planRevision: counter, buildGeneration: counter, retryUsed: z.record(z.string(), counter), phaseExecutions: z.record(z.string(), counter), repairRounds: counter })).optional(),
  installedLockDigest: text.optional(),
  tasks: z.record(z.string(), taskSchema),
  calls: z.record(z.string(), z.object({ identity: identitySchema, workDir: text, status: z.enum(['queued', 'running', 'exited', 'uncertain']), pid: z.number().int().positive().optional(), startedAt: text.optional(), exitedAt: text.optional() })),
  retryUsed: z.record(z.string(), counter), phaseExecutions: z.record(z.string(), counter),
  buildEntry: z.enum(['execute-graph', 'repair-integration']), repairRounds: counter,
  repairs: z.array(z.object({ round: counter, report: z.string(), source: text, before: text.optional(), after: text.optional(), identity: identitySchema.optional() })),
  integrationBase: text.optional(), integrationHead: text.optional(), candidateCommit: text.optional(), verify: receiptSchema.optional(), uat: receiptSchema.optional(),
  delivery: z.object({ repository: text, issueNumber: z.number().int().positive(), sourceBranch: text, targetBranch: text, marker: text, creation: z.enum(['unstarted', 'unknown', 'confirmed']), prNumber: z.number().int().positive().optional(), prUrl: text.optional(), remoteCommit: text.optional(), pushedCommit: text.optional(), issueWrittenCommit: text.optional(), issueWriteIntent: z.object({ commit: text, marker: text, requestedAt: text }).optional(), pushIntent: z.object({ commit: text, lease: text.optional() }).optional() }).optional(),
  workspaces: z.array(z.object({ directory: text, branch: text, taskId: text, attemptNo: counter, createdAt: text, cleanedAt: text.optional() })).optional(),
  temporaryFiles: z.array(text).optional(), recoveryRequired: z.boolean().optional(),
}).passthrough();

/** 启动时验证完整运行结构及凭证之间的必要关系，绝不以默认值吞掉损坏数据。 */
export function validateRun(value: unknown, issueNumber: number): void {
  const run = runSchema.parse(value);
  if (run.planRevision > 0 && !run.planDigest) throw new Error('计划引用缺少摘要');
  if (run.review && run.review.revision !== run.planRevision) throw new Error('审核版本与计划引用不一致');
  for (const [id, task] of Object.entries(run.tasks)) {
    if (task.taskId !== id) throw new Error('任务索引与身份不一致');
    if (task.success && (task.success.identity.issueNumber !== issueNumber || task.success.identity.planRevision !== run.planRevision || task.success.identity.buildGeneration !== run.buildGeneration || task.success.identity.taskId !== id)) throw new Error('成功凭证的计划或构建轮次不匹配');
    if (['waiting-merge', 'merging', 'merged'].includes(task.status) && !task.success) throw new Error('待合并任务缺少成功凭证');
    if (task.merge && (!task.success || (task.merge.stage !== 'rebasing' && !task.merge.postRebaseCommit))) throw new Error('合并操作缺少结果提交');
    if (task.status === 'merged' && (task.merge?.stage !== 'merged' || task.merge.integrationAfter !== task.merge.postRebaseCommit)) throw new Error('已合并任务缺少完整集成凭证');
  }
  for (const [id, call] of Object.entries(run.calls)) if (id !== call.identity.callId || call.identity.issueNumber !== issueNumber) throw new Error('调用索引或所属 Issue 不匹配');
  if (run.delivery && run.delivery.issueNumber !== issueNumber) throw new Error('交付身份与父 Issue 不匹配');
  if (run.uat && !run.uat.runId) throw new Error('浏览器验收凭证缺少本次运行编号');
}
