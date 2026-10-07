import { describe, expect, it } from 'vitest';
import {
  VERIFY_AGENT_OUTPUT_SCHEMA,
  evaluateVerifyResult,
  parseVerifyAgentOutput,
} from '../../src/verify/VerifyResultCodec.js';
import { verifyAgentOutput } from '../helpers/verify-result.js';

describe('Verify Agent JSON 契约', () => {
  it.each([1, null])('退出码为 %s 时，即使模型声称通过也不能放行', exitCode => {
    const result = parseVerifyAgentOutput(verifyAgentOutput());
    result.checks.test.exitCode = exitCode;
    expect(evaluateVerifyResult(result).passed).toBe(false);
  });
  it('接受完整结构化结果并根据三个检查项计算通过状态', () => {
    const result = parseVerifyAgentOutput(verifyAgentOutput());

    expect(result.schemaVersion).toBe('iaf-mini/verify/v1');
    expect(evaluateVerifyResult(result)).toEqual({ passed: true, failureReasons: [] });
  });

  it('失败检查会产生服务端失败原因，不依赖展示 Markdown', () => {
    const result = parseVerifyAgentOutput(verifyAgentOutput({ test: 'failed', reportMarkdown: '任意展示文本' }));

    expect(evaluateVerifyResult(result)).toEqual({
      passed: false,
      failureReasons: ['Test 检查失败：Test 失败'],
    });
  });

  it('拒绝 Markdown、代码块和缺少结构化检查的输出', () => {
    expect(() => parseVerifyAgentOutput('# 验证报告\n\n**Test 结果**：通过')).toThrow();
    expect(() => parseVerifyAgentOutput(`\`\`\`json\n${verifyAgentOutput()}\n\`\`\``)).toThrow();
    const incomplete = JSON.parse(verifyAgentOutput());
    delete incomplete.checks.test;
    expect(() => parseVerifyAgentOutput(JSON.stringify(incomplete))).toThrow();
  });

  it('SDK Schema 要求三个检查项且禁止额外字段', () => {
    expect(VERIFY_AGENT_OUTPUT_SCHEMA.required).toEqual([
      'schemaVersion',
      'phase',
      'checks',
      'summary',
      'reportMarkdown',
    ]);
    expect(VERIFY_AGENT_OUTPUT_SCHEMA).toMatchObject({
      properties: { checks: { required: ['lint', 'build', 'test'] } },
    });
    expect(VERIFY_AGENT_OUTPUT_SCHEMA.additionalProperties).toBe(false);
  });
});
