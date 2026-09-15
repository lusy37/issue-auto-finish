import { z } from 'zod';

/** 流程名称固定；具体执行位置由 LangGraph 的检查点与待执行节点保存。 */
export const PHASE_IDS = ['plan', 'review', 'build', 'verify', 'uat'] as const;
export type PhaseId = typeof PHASE_IDS[number];
export type WorkflowNode = PhaseId | 'deliver';
export type ReviewDecision = {
  planRevision: number;
  action: 'approve' | 'reject';
  feedback?: string;
  source?: 'manual' | 'label' | 'configuration';
};

export const reviewDecisionSchema = z.object({
  planRevision: z.number().int().positive(),
  action: z.enum(['approve', 'reject']),
  feedback: z.string().optional(),
  source: z.enum(['manual', 'label', 'configuration']).optional(),
}).refine(value => value.action !== 'reject' || !!value.feedback?.trim(), '驳回必须提供反馈');

/** 仅保存框架序列化后的数据，不保存执行器、Promise 或进程句柄。 */
export interface SerializedValue { type: string; data: string }
export interface StoredCheckpoint {
  threadId: string;
  namespace: string;
  id: string;
  parentId?: string;
  checkpoint: SerializedValue;
  metadata: SerializedValue;
}
export interface StoredWrite {
  threadId: string;
  namespace: string;
  checkpointId: string;
  taskId: string;
  index: number;
  channel: string;
  value: SerializedValue;
}
export interface PhaseResultSummary {
  phase: WorkflowNode;
  outcome: 'completed' | 'retried-from' | 'gate-approved' | 'gate-rejected';
  next: WorkflowNode | '__end__';
  sessionId?: string;
  report?: string;
  failures?: readonly string[];
}
export interface WorkflowStorage {
  generation: number;
  entry: WorkflowNode;
  checkpoints: StoredCheckpoint[];
  writes: StoredWrite[];
  /** 阶段结果与业务事实在同一事务提交，覆盖节点结束至检查点落盘之间的崩溃窗口。 */
  results: Record<string, PhaseResultSummary>;
  effects: string[];
}
export function newWorkflowStorage(): WorkflowStorage {
  return { generation: 0, entry: 'plan', checkpoints: [], writes: [], results: {}, effects: [] };
}

const serializedValue = z.object({
  type: z.string(),
  data: z.string(),
});

export const workflowStorageSchema = z.object({
  generation: z.number().int().nonnegative(),
  entry: z.enum([...PHASE_IDS, 'deliver']),
  checkpoints: z.array(z.object({
    threadId: z.string(),
    namespace: z.string(),
    id: z.string(),
    parentId: z.string().optional(),
    checkpoint: serializedValue,
    metadata: serializedValue,
  })),
  writes: z.array(z.object({
    threadId: z.string(),
    namespace: z.string(),
    checkpointId: z.string(),
    taskId: z.string(),
    index: z.number().int(),
    channel: z.string(),
    value: serializedValue,
  })),
  results: z.record(z.string(), z.object({
    phase: z.enum([...PHASE_IDS, 'deliver']),
    outcome: z.enum(['completed', 'retried-from', 'gate-approved', 'gate-rejected']),
    next: z.enum([...PHASE_IDS, 'deliver', '__end__']),
    sessionId: z.string().optional(),
    report: z.string().optional(),
    failures: z.array(z.string()).optional(),
  })),
  effects: z.array(z.string()),
});
