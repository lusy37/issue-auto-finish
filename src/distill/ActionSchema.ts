import { z } from "zod";
const text = z.string().min(1);
const ids = z.array(text);
const theme = z.enum([
  "failure-pattern",
  "efficiency-insight",
  "intervention-pattern",
  "optimization-suggestion",
  "rejection-pattern",
]);
/** 在任何持久化副作用前校验完整批次，避免畸形 AI 响应消费日记。 */
export const memoryActionsSchema = z.array(
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("CREATE"),
      theme,
      title: text,
      content: text,
      diaryIds: ids,
    }),
    z.object({
      type: z.literal("MERGE"),
      memoryId: text,
      newEvidence: ids,
      updatedContent: text.optional(),
    }),
    z.object({
      type: z.literal("SUPERSEDE"),
      oldMemoryId: text,
      theme,
      title: text,
      content: text,
      diaryIds: ids,
    }),
  ]),
);
export const ruleActionsSchema = z.array(
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("CREATE"),
      ruleName: text,
      title: text,
      content: text,
      keywords: ids,
      alwaysApply: z.boolean(),
      sourceMemoryIds: ids,
    }),
    z.object({
      type: z.literal("UPDATE"),
      ruleId: text,
      content: text,
      keywords: ids.optional(),
    }),
    z.object({ type: z.literal("DEPRECATE"), ruleId: text, reason: text }),
  ]),
);
