import { z } from 'zod';
import { assertPlanInvariants } from '../invariants.js';
import type { PlanContent } from '../contracts.js';

const nonEmptyText = z.string().trim().min(1);
const taskPlanSchema = z.object({
  title: nonEmptyText,
  description: nonEmptyText,
  acceptanceCriteria: z.array(nonEmptyText).min(1),
  tasks: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/),
    title: nonEmptyText,
    instructions: nonEmptyText,
    acceptanceCriteria: z.array(nonEmptyText).min(1),
    dependsOn: z.array(z.string()).max(19),
  }).strict()).min(1).max(20),
}).strict();

/** AI/文件输入边界：先校验字段形状，再执行普通 DAG invariant。 */
export function decodePlanContent(value: unknown): PlanContent {
  const plan = taskPlanSchema.parse(value);
  assertPlanInvariants(plan);
  return plan;
}
