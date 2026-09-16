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
export interface WorkflowDefinition {
  /** 本轮工作流的不可变阶段集合；顺序同时用于页面投影。 */
  phaseIds: PhaseId[];
}
export interface WorkflowStorage {
  generation: number;
  entry: WorkflowNode;
  /** 首次 setup 时固化；pending 任务在 setup 前允许尚未初始化。 */
  definition?: WorkflowDefinition;
  checkpoints: StoredCheckpoint[];
  writes: StoredWrite[];
  /** 阶段结果与业务事实在同一事务提交，覆盖节点结束至检查点落盘之间的崩溃窗口。 */
  results: Record<string, PhaseResultSummary>;
  effects: string[];
}
export function newWorkflowStorage(): WorkflowStorage {
  return { generation: 0, entry: 'plan', checkpoints: [], writes: [], results: {}, effects: [] };
}

export function initializeWorkflowDefinition(
  workflow: WorkflowStorage,
  phaseIds: readonly string[],
): WorkflowDefinition {
  const unique = new Set(phaseIds);
  if (unique.size !== phaseIds.length
    || phaseIds.some(id => !PHASE_IDS.includes(id as PhaseId))
    || !['plan', 'review', 'build', 'verify'].every(id => unique.has(id))) {
    throw new Error('工作流阶段定义无效');
  }
  const definition = { phaseIds: phaseIds as PhaseId[] };
  if (workflow.definition) {
    if (workflow.definition.phaseIds.length !== definition.phaseIds.length
      || workflow.definition.phaseIds.some((id, index) => id !== definition.phaseIds[index])) {
      throw new Error('本轮工作流阶段定义已固化，不能随全局配置改变');
    }
    return workflow.definition;
  }
  workflow.definition = { phaseIds: [...definition.phaseIds] };
  return workflow.definition;
}

export function requiresWorkflowPhase(workflow: WorkflowStorage, phase: PhaseId): boolean {
  if (!workflow.definition) throw new Error('工作流阶段定义尚未初始化');
  return workflow.definition.phaseIds.includes(phase);
}

const serializedValue = z.object({
  type: z.string(),
  data: z.string(),
});

export const workflowStorageSchema = z.object({
  generation: z.number().int().nonnegative(),
  entry: z.enum([...PHASE_IDS, 'deliver']),
  definition: z.object({ phaseIds: z.array(z.enum(PHASE_IDS)).min(4) }).optional(),
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
