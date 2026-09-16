import { z } from 'zod';
import { assertWorkflowStorageShape } from '../../orchestration/codecs/WorkflowCodec.js';
import type { IssueRun } from '../contracts.js';

const counter = z.number().int().nonnegative();
const text = z.string().min(1);
const identitySchema = z.object({
  issueNumber: z.number().int().positive(),
  planRevision: counter,
  buildGeneration: counter,
  dispatchId: text,
  taskId: text,
  attemptNo: counter,
  callId: text,
});
const successSchema = z.object({
  identity: identitySchema,
  completedAt: text,
  resultCommit: text,
  noChange: z.boolean(),
  sessionId: text.optional(),
});
const mergeSchema = z.object({
  operationId: text,
  stage: z.enum(['rebasing', 'ready', 'merged']),
  preRebaseCommit: text,
  integrationBefore: text,
  postRebaseCommit: text.optional(),
  integrationAfter: text.optional(),
});
const taskSchema = z.object({
  taskId: text,
  status: z.enum(['pending', 'running', 'waiting-merge', 'merging', 'merged', 'failed', 'uncertain']),
  attemptNo: counter,
  conflictCallsUsed: counter.max(2),
  identity: identitySchema.optional(),
  startCommit: text.optional(),
  branch: text.optional(),
  workDir: text.optional(),
  success: successSchema.optional(),
  merge: mergeSchema.optional(),
  error: z.string().optional(),
});
const receiptSchema = z.object({
  commit: text,
  completedAt: text,
  passed: z.literal(true),
  reportPath: text,
  runId: text.optional(),
});
const runSchema = z.object({
  workflow: z.unknown(),
  version: counter,
  planRevision: counter,
  planDigest: text.optional(),
  buildGeneration: counter,
  dispatchId: text.optional(),
  stopIntent: z.object({ kind: z.enum(['pause', 'cancel', 'redo']), requestedAt: text }).optional(),
  review: z.object({
    revision: counter,
    decision: z.enum(['waiting', 'approved', 'rejected']),
    feedback: z.string().optional(),
    source: z.string().optional(),
  }).optional(),
  activeCalls: z.record(z.string(), text).optional(),
  reviewHistory: z.array(z.object({
    round: counter,
    revision: counter,
    feedback: z.string(),
    timestamp: text,
    planSnapshot: z.string(),
    reviewedSessionId: text.optional(),
  })).optional(),
  budgetHistory: z.array(z.object({
    planRevision: counter,
    buildGeneration: counter,
    retryUsed: z.record(z.string(), counter),
    phaseExecutions: z.record(z.string(), counter),
    repairRounds: counter,
  })).optional(),
  installedLockDigest: text.optional(),
  tasks: z.record(z.string(), taskSchema),
  calls: z.record(z.string(), z.object({
    identity: identitySchema,
    workDir: text,
    status: z.enum(['queued', 'running', 'exited', 'uncertain']),
    pid: z.number().int().positive().optional(),
    startedAt: text.optional(),
    exitedAt: text.optional(),
  })),
  retryUsed: z.record(z.string(), counter),
  phaseExecutions: z.record(z.string(), counter),
  buildEntry: z.enum(['execute-graph', 'repair-integration']),
  repairRounds: counter,
  repairs: z.array(z.object({
    round: counter,
    report: z.string(),
    source: text,
    before: text.optional(),
    after: text.optional(),
    identity: identitySchema.optional(),
  })),
  integrationBase: text.optional(),
  integrationHead: text.optional(),
  candidateCommit: text.optional(),
  verify: receiptSchema.optional(),
  uat: receiptSchema.optional(),
  delivery: z.object({
    repository: text,
    issueNumber: z.number().int().positive(),
    sourceBranch: text,
    targetBranch: text,
    marker: text,
    creation: z.enum(['unstarted', 'unknown', 'confirmed']),
    prNumber: z.number().int().positive().optional(),
    prUrl: text.optional(),
    remoteCommit: text.optional(),
    pushedCommit: text.optional(),
    issueWrittenCommit: text.optional(),
    issueWriteIntent: z.object({ commit: text, marker: text, requestedAt: text }).optional(),
    pushIntent: z.object({ commit: text, lease: text.optional() }).optional(),
  }).optional(),
  workspaces: z.array(z.object({
    directory: text,
    branch: text,
    taskId: text,
    attemptNo: counter,
    createdAt: text,
    cleanedAt: text.optional(),
  })).optional(),
  temporaryFiles: z.array(text).optional(),
  recoveryRequired: z.boolean().optional(),
}).passthrough();

/** 聚合文件边界只验证字段形状；跨字段与父子身份规则由 invariant 层处理。 */
export function assertIssueRunShape(value: unknown): asserts value is IssueRun {
  const run = runSchema.parse(value);
  assertWorkflowStorageShape(run.workflow);
}
