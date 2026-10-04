import { z } from 'zod';

/** VERIFY Agent 输出的版本化契约。流程只信任结构化字段，Markdown 只用于展示。 */
export const VERIFY_AGENT_SCHEMA_VERSION = 'iaf-mini/verify/v1' as const;

const nonEmptyText = z.string().trim().min(1);

const checkSchema = z
  .object({
    status: z.enum(['passed', 'failed']),
    command: nonEmptyText,
    exitCode: z.number().int().nullable(),
    summary: nonEmptyText,
    diagnostics: z.array(nonEmptyText).max(100),
  })
  .strict();

const verifyAgentResultSchema = z
  .object({
    schemaVersion: z.literal(VERIFY_AGENT_SCHEMA_VERSION),
    phase: z.literal('verify'),
    checks: z
      .object({
        lint: checkSchema,
        build: checkSchema,
        test: checkSchema,
      })
      .strict(),
    summary: nonEmptyText,
    reportMarkdown: nonEmptyText,
  })
  .strict();

/** SDK 输出契约由运行时校验生成，避免字段重复维护。 */
export const VERIFY_AGENT_OUTPUT_SCHEMA = z.toJSONSchema(verifyAgentResultSchema);

export type VerifyCheck = z.infer<typeof checkSchema>;
export type VerifyAgentResult = z.infer<typeof verifyAgentResultSchema>;

export interface VerifyEvaluation {
  passed: boolean;
  failureReasons: string[];
}

/** 只允许解析 JSON；Markdown 表格或自然语言不会被当作验证凭证。 */
export function parseVerifyAgentOutput(output: string): VerifyAgentResult {
  const text = output.trim();
  if (!text) throw new Error('VERIFY Agent 输出为空');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`VERIFY Agent 输出不是有效 JSON：${(error as Error).message}`);
  }
  try {
    return verifyAgentResultSchema.parse(parsed);
  } catch (error) {
    throw new Error(`VERIFY Agent 输出不符合 JSON 契约：${(error as Error).message}`);
  }
}

/** 服务端根据三个结构化检查结果计算结论，不信任 Agent 自行声明的总状态。 */
export function evaluateVerifyResult(result: VerifyAgentResult): VerifyEvaluation {
  const checks: Array<[string, VerifyCheck]> = [
    ['Lint', result.checks.lint],
    ['Build', result.checks.build],
    ['Test', result.checks.test],
  ];
  const failureReasons = checks
    .filter(([, check]) => check.status !== 'passed')
    .map(([label, check]) => `${label} 检查失败：${check.summary}`);
  return { passed: failureReasons.length === 0, failureReasons };
}
