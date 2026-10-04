import fs from 'node:fs';
import path from 'node:path';
import { ManagedCodexRunner } from '../src/ai-runner/ManagedCodexRunner.js';
import { runProcess } from '../src/utils/process.js';
import { TASK_PLAN_OUTPUT_SCHEMA, decodePlanContent } from '../src/dag/codecs/TaskPlanCodec.js';
import { VERIFY_AGENT_OUTPUT_SCHEMA, parseVerifyAgentOutput } from '../src/verify/VerifyResultCodec.js';
import { MEMORY_OUTPUT_SCHEMA, RULE_OUTPUT_SCHEMA, memoryOutputSchema, ruleOutputSchema } from '../src/distill/ActionSchema.js';

// 独立验证真实 SDK 的 Schema 兼容性；不调用工具、不执行开发流程或平台写入。
const root = path.resolve('.iaf-mini/infrastructure-simplification');
fs.mkdirSync(root, { recursive: true });
const workDir = fs.mkdtempSync(path.join(root, 'schema-smoke-'));
await runProcess('git', ['init'], { cwd: workDir });
const runner = new ManagedCodexRunner(process.env.CODEX_BINARY || '', process.env.AI_MODEL || undefined);
const cases = [
  {
    name: 'plan', schema: TASK_PLAN_OUTPUT_SCHEMA,
    example: {
      title: '契约验证', description: '只验证结构化计划格式', acceptanceCriteria: ['格式有效'],
      tasks: [{ id: 'check', title: '检查', instructions: '验证格式', acceptanceCriteria: ['通过'], dependsOn: [] }],
    },
    validate: (output: string) => decodePlanContent(JSON.parse(output)),
  },
  {
    name: 'verify', schema: VERIFY_AGENT_OUTPUT_SCHEMA,
    example: {
      schemaVersion: 'iaf-mini/verify/v1', phase: 'verify',
      checks: Object.fromEntries(['lint', 'build', 'test'].map(name => [name, {
        status: 'passed', command: 'contract-only', exitCode: 0,
        summary: '仅为契约验证样例，未执行检查', diagnostics: [],
      }])),
      summary: '仅验证格式，不作为项目验收结论', reportMarkdown: '契约验证样例',
    },
    validate: parseVerifyAgentOutput,
  },
  {
    name: 'memory', schema: MEMORY_OUTPUT_SCHEMA,
    example: { actions: [{ type: 'MERGE', memoryId: 'sample', newEvidence: ['sample'], updatedContent: null }] },
    validate: (output: string) => memoryOutputSchema.parse(JSON.parse(output)),
  },
  {
    name: 'rule', schema: RULE_OUTPUT_SCHEMA,
    example: { actions: [{ type: 'UPDATE', ruleId: 'sample', content: '契约验证样例', keywords: null }] },
    validate: (output: string) => ruleOutputSchema.parse(JSON.parse(output)),
  },
];
const results: Array<{ name: string; passed: boolean; error?: string }> = [];
try {
  for (const item of cases) {
    try {
      item.validate(JSON.stringify(item.example));
      const result = await runner.run({
        workDir, mode: 'plan', timeoutMs: 60_000, outputSchema: item.schema,
        prompt: `这是结构化输出格式验证。不要调用工具、读取或修改文件。请按提供的 Schema 返回以下固定 JSON，保持字段值：${JSON.stringify(item.example)}`,
      });
      if (!result.success) throw new Error(result.errorMessage || 'SDK 调用失败');
      item.validate(result.output);
      results.push({ name: item.name, passed: true });
    } catch (error) {
      results.push({ name: item.name, passed: false, error: (error as Error).message });
    }
    console.log(JSON.stringify(results.at(-1)));
  }
} finally {
  runner.killAll();
  await runner.waitForIdle();
}
fs.writeFileSync(path.join(root, 'sdk-schema-smoke.json'), JSON.stringify({ workDir, results }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
