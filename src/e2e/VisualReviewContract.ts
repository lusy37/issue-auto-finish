import { z } from 'zod';
import type { JsonSchema } from '../ai-runner/AIRunner.js';
import { viewportSchema } from './UatSchemas.js';

const outputSchema = z.object({
  summary: z.string().max(4000),
  screenshots: z.array(z.object({
    id: z.string().min(1),
    assessment: z.enum(['clear', 'defect', 'uncertain', 'unreadable']),
    reason: z.string().max(2000),
    issues: z.array(z.object({
      severity: z.enum(['blocker', 'major', 'minor']),
      description: z.string().min(1).max(2000),
      expected: z.string().min(1).max(2000),
      observed: z.string().min(1).max(2000),
    }).strict()),
  }).strict()),
  coverageGaps: z.array(z.object({
    description: z.string().min(1).max(500),
    kind: z.enum([
      'missing-case',
      'missing-viewport',
      'missing-visible-state',
      'unreadable-image',
      'incomplete-agent-output',
    ]),
    acceptanceRefs: z.array(z.string().min(1)).min(1),
    caseId: z.string().min(1).nullable(),
    sceneId: z.string().min(1).nullable(),
    viewport: viewportSchema.nullable(),
    screenshotIds: z.array(z.string().min(1)),
  }).strict()).max(100),
}).strict();

export const visualRepairDecisionSchema = z.object({
  schemaVersion: z.literal('iaf-mini/visual-repair/v1'),
  decision: z.enum(['behavior-covered', 'add-visual-evidence', 'fix-ui', 'retry-visual']),
  sourceRunId: z.string().min(1),
  candidateCommit: z.string().min(1),
  planRevision: z.number().int().nonnegative(),
  planDigest: z.string().min(1),
  buildGeneration: z.number().int().nonnegative(),
  gapIndex: z.number().int().nonnegative(),
  reason: z.string().min(1),
  testRefs: z.array(z.object({
    path: z.string().min(1),
    line: z.number().int().positive(),
    testId: z.string().min(1),
    acceptanceRefs: z.array(z.string().min(1)),
    reportDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()),
  changedFiles: z.array(z.string().min(1)),
}).strict();

/** SDK 要求字段全部必填；null 仅在协议边界转换为领域中的可选值。 */
const parsedOutputSchema = outputSchema.transform(output => ({
  ...output,
  coverageGaps: output.coverageGaps.map(gap => ({
    ...gap,
    caseId: gap.caseId ?? undefined,
    sceneId: gap.sceneId ?? undefined,
    viewport: gap.viewport ?? undefined,
  })),
}));

export type VisualReviewOutput = z.infer<typeof parsedOutputSchema>;
export type VisualRepairDecisionPayload = z.infer<typeof visualRepairDecisionSchema>;

/** SDK 结构化输出契约直接由运行时 Schema 生成，避免双重维护。 */
export const VISUAL_REVIEW_OUTPUT_SCHEMA = z.toJSONSchema(outputSchema) as JsonSchema;
export const VISUAL_REPAIR_OUTPUT_SCHEMA = z.toJSONSchema(visualRepairDecisionSchema) as JsonSchema;

export function parseVisualReviewOutput(text: string): VisualReviewOutput {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('视觉复核没有返回合法 JSON');
  }
  return parsedOutputSchema.parse(value);
}

export function parseVisualRepairDecision(text: string): VisualRepairDecisionPayload {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('视觉修复决定不是合法 JSON');
  }
  return visualRepairDecisionSchema.parse(value);
}
