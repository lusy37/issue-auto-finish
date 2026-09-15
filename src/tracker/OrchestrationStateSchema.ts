import { z } from 'zod';
import type { OrchestrationState } from '../orchestration/OrchestrationState.js';

/** 只校验当前快照格式，不推导、不补默认值、不迁移。 */
export const orchestrationStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('queued') }),
  z.object({ kind: z.literal('running'), phaseId: z.string() }),
  z.object({ kind: z.literal('gate-waiting'), phaseId: z.string(), reason: z.string(), payload: z.record(z.string(), z.unknown()).optional() }),
  z.object({ kind: z.literal('gate-approved'), phaseId: z.string() }),
  z.object({ kind: z.literal('paused'), phaseId: z.string() }),
  z.object({ kind: z.literal('pipeline-completed') }),
  z.object({
    kind: z.literal('pipeline-failed'), failedAt: z.string(), retryable: z.enum(['auto', 'manual']),
    error: z.object({ message: z.string(), retryable: z.enum(['soft', 'hard', 'hard-no-auto']), rawOutput: z.string().optional() }).optional(),
  }),
  z.object({ kind: z.literal('conflict-resolving') }),
]) satisfies z.ZodType<OrchestrationState>;
