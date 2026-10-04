import { z } from 'zod';
import {
  PHASE_IDS,
  assertReviewDecisionInvariant,
  type ReviewDecision,
  type WorkflowStorage,
} from '../WorkflowState.js';

const serializedValueSchema = z.object({
  type: z.string(),
  data: z.string(),
});

const workflowStorageSchema = z.object({
  generation: z.number().int().nonnegative(),
  entry: z.enum([...PHASE_IDS, 'deliver']),
  definition: z.object({ phaseIds: z.array(z.enum(PHASE_IDS)) }).optional(),
  checkpoints: z.array(
    z.object({
      threadId: z.string(),
      namespace: z.string(),
      id: z.string(),
      parentId: z.string().optional(),
      checkpoint: serializedValueSchema,
      metadata: serializedValueSchema,
    }),
  ),
  writes: z.array(
    z.object({
      threadId: z.string(),
      namespace: z.string(),
      checkpointId: z.string(),
      taskId: z.string(),
      index: z.number().int(),
      channel: z.string(),
      value: serializedValueSchema,
    }),
  ),
  results: z.record(
    z.string(),
    z.object({
      phase: z.enum([...PHASE_IDS, 'deliver']),
      outcome: z.enum(['completed', 'retried-from', 'retried-current', 'gate-approved', 'gate-rejected']),
      next: z.enum([...PHASE_IDS, 'deliver', '__end__']),
      sessionId: z.string().optional(),
      report: z.string().optional(),
      failures: z.array(z.string()).optional(),
    }),
  ),
  effects: z.array(z.string()),
});

const reviewDecisionSchema = z.object({
  planRevision: z.number().int().positive(),
  action: z.enum(['approve', 'reject']),
  feedback: z.string().optional(),
  source: z.enum(['manual', 'label', 'configuration']).optional(),
});

/** 仅在 checkpoint 持久化边界校验字段形状。 */
export function assertWorkflowStorageShape(value: unknown): asserts value is WorkflowStorage {
  workflowStorageSchema.parse(value);
}

/** 审核决定来自 HTTP 或 LangGraph interrupt，必须在进入业务逻辑前解码。 */
export function decodeReviewDecision(value: unknown): ReviewDecision {
  const decision = reviewDecisionSchema.parse(value);
  assertReviewDecisionInvariant(decision);
  return decision;
}
