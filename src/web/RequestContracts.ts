import { z } from 'zod';

/** HTTP 输入只在路由边界解析，业务层使用解析后的普通值。 */
export const issueNumberSchema = z.string().regex(/^[1-9]\d*$/, '需要正整数 Issue 编号')
  .transform(Number).pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const supplementSchema = z.object({
  requirements: z.string().default(''),
  acceptanceCriteria: z.string().default(''),
  scope: z.string().default(''),
  constraints: z.string().default(''),
  references: z.string().default(''),
  freeText: z.string().default(''),
}).strict();
export const startIssueSchema = z.object({
  issueIid: positiveInteger,
  issueId: positiveInteger.optional(),
  issueTitle: z.string().optional(),
  supplement: supplementSchema.optional(),
}).strict();
export const reviewSchema = z.object({
  planRevision: positiveInteger.optional(),
  feedback: z.string().trim().min(1).optional(),
}).strict();
export const phaseSchema = z.object({ phase: z.string().min(1) }).strict();
export const contentSchema = z.object({ content: z.string() }).strict();
export const noteSyncSchema = z.object({ enabled: z.boolean().nullable() }).strict();
export const booleanSettingSchema = z.object({ enabled: z.boolean() }).strict();
export const browseQuerySchema = z.object({
  search: z.string().max(500).default(''),
  page: issueNumberSchema.default(1),
  per_page: issueNumberSchema.pipe(z.number().max(100)).default(20),
});
export const logQuerySchema = z.object({
  taskId: z.string().optional(),
  attemptNo: issueNumberSchema.optional(),
});
export const settingsSchema = z.object({
  values: z.record(z.string(), z.string().regex(/^[^\r\n']*$/, '配置值不能包含换行或单引号')),
}).strict();
