import { describe, expect, it } from 'vitest';
import {
  parseVisualReviewOutput, VISUAL_REVIEW_OUTPUT_SCHEMA, VISUAL_REPAIR_OUTPUT_SCHEMA,
} from '../../src/e2e/VisualReviewContract.js';
import { VERIFY_AGENT_OUTPUT_SCHEMA } from '../../src/verify/VerifyResultCodec.js';

/** 遍历所有嵌套对象，防止模拟 AI 掩盖 SDK 严格结构化输出的契约错误。 */
function assertStrictObjects(schema: unknown): void {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema)) {
    schema.forEach(assertStrictObjects);
    return;
  }
  const node = schema as Record<string, unknown>;
  if (node.properties) {
    expect(node.additionalProperties).toBe(false);
    expect([...(node.required as string[] ?? [])].sort()).toEqual(
      Object.keys(node.properties as Record<string, unknown>).sort(),
    );
  }
  Object.values(node).forEach(assertStrictObjects);
}

const gap = {
  description: '缺少加载状态', kind: 'missing-visible-state',
  acceptanceRefs: ['plan:0'], screenshotIds: [], caseId: null, sceneId: null, viewport: null,
};
const output = { summary: '缺少证据', screenshots: [], coverageGaps: [gap] };

describe('SDK 严格结构化输出与内部领域契约', () => {
  it.each([
    ['视觉复核', VISUAL_REVIEW_OUTPUT_SCHEMA],
    ['视觉修复', VISUAL_REPAIR_OUTPUT_SCHEMA],
    ['Verify', VERIFY_AGENT_OUTPUT_SCHEMA],
  ])('%s 的每个对象都禁止额外字段并要求全部字段', (_, schema) => {
    assertStrictObjects(schema);
  });

  it('无具体场景的 null 在边界转换为内部可选字段', () => {
    const parsed = parseVisualReviewOutput(JSON.stringify(output));
    expect(parsed.coverageGaps[0]).toMatchObject({
      description: gap.description, caseId: undefined, sceneId: undefined, viewport: undefined,
    });
    expect(JSON.parse(JSON.stringify(parsed)).coverageGaps[0]).not.toHaveProperty('caseId');
  });

  it('具体场景、视口信息通过协议边界后完整保留', () => {
    const concrete = { ...gap, caseId: 'desktop', sceneId: 'loading',
      viewport: { width: 1440, height: 900 } };
    const parsed = parseVisualReviewOutput(JSON.stringify({ ...output, coverageGaps: [concrete] }));
    expect(parsed.coverageGaps[0]).toEqual(concrete);
  });

  it.each(['caseId', 'sceneId', 'viewport'])('遗漏 %s 必须拒绝，不能接受不符合 SDK 的结果', key => {
    const incomplete: Record<string, unknown> = { ...gap };
    delete incomplete[key];
    expect(() => parseVisualReviewOutput(JSON.stringify({ ...output, coverageGaps: [incomplete] })))
      .toThrow();
  });

  it('非法视口与未知字段不能被 null 规范化掩盖', () => {
    for (const invalid of [{ ...gap, viewport: { width: 0, height: 900 } }, { ...gap, passed: true }]) {
      expect(() => parseVisualReviewOutput(JSON.stringify({ ...output, coverageGaps: [invalid] })))
        .toThrow();
    }
  });
});
