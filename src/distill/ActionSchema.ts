import { z } from 'zod';
const text = z.string().min(1);
const ids = z.array(text);
const theme = z.enum([
  'failure-pattern',
  'efficiency-insight',
  'intervention-pattern',
  'optimization-suggestion',
  'rejection-pattern',
]);
/** 在任何持久化副作用前校验完整批次，避免畸形 AI 响应消费日记。 */
export const memoryActionsSchema = z.array(
  z.union([
    z.object({
      type: z.literal('CREATE'),
      theme,
      title: text,
      content: text,
      diaryIds: ids,
    }),
    z.object({
      type: z.literal('MERGE'),
      memoryId: text,
      newEvidence: ids,
      updatedContent: text.nullable().transform(value => value ?? undefined).optional(),
    }),
    z.object({
      type: z.literal('SUPERSEDE'),
      oldMemoryId: text,
      theme,
      title: text,
      content: text,
      diaryIds: ids,
    }),
  ]),
);
export const ruleActionsSchema = z.array(
  z.union([
    z.object({
      type: z.literal('CREATE'),
      ruleName: text,
      title: text,
      content: text,
      keywords: ids,
      alwaysApply: z.boolean(),
      sourceMemoryIds: ids,
    }),
    z.object({
      type: z.literal('UPDATE'),
      ruleId: text,
      content: text,
      keywords: ids.nullable().transform(value => value ?? undefined).optional(),
    }),
    z.object({ type: z.literal('DEPRECATE'), ruleId: text, reason: text }),
  ]),
);

/** 最终响应和持久化前校验共用同一份批次契约。 */
export const memoryOutputSchema = z.object({ actions: memoryActionsSchema }).strict();
export const ruleOutputSchema = z.object({ actions: ruleActionsSchema }).strict();
function sdkSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema, {
    io: 'input',
    // Codex 结构化输出要求所有字段必填；可选值用 null 表示，解析后归一为 undefined。
    override: ({ jsonSchema }) => {
      if (jsonSchema.type === 'object') {
        jsonSchema.additionalProperties = false;
        jsonSchema.required = Object.keys(jsonSchema.properties ?? {});
      }
    },
  });
}
export const MEMORY_OUTPUT_SCHEMA = sdkSchema(memoryOutputSchema);
export const RULE_OUTPUT_SCHEMA = sdkSchema(ruleOutputSchema);
