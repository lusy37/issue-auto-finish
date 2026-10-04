import { expect, it } from 'vitest';
import { MEMORY_OUTPUT_SCHEMA, RULE_OUTPUT_SCHEMA, memoryOutputSchema, ruleOutputSchema } from '../../src/distill/ActionSchema.js';

it('蒸馏可选值 null 归一为原业务类型，同时兼容已有的省略字段', () => {
  const merge = { type: 'MERGE', memoryId: 'm1', newEvidence: ['d1'] };
  expect(memoryOutputSchema.parse({ actions: [{ ...merge, updatedContent: null }] })).toEqual({
    actions: [{ ...merge, updatedContent: undefined }],
  });
  expect(memoryOutputSchema.parse({ actions: [merge] }).actions[0]).toEqual(merge);
  expect(ruleOutputSchema.parse({ actions: [{ type: 'UPDATE', ruleId: 'r1', content: '规则', keywords: null }] }).actions[0]).toMatchObject({ keywords: undefined });
  expect(() => memoryOutputSchema.parse({ actions: [{ ...merge, updatedContent: 123 }] })).toThrow();
});

it('SDK 契约使用可支持的联合类型，并显式要求可选值字段', () => {
  expect(JSON.stringify(MEMORY_OUTPUT_SCHEMA)).not.toContain('oneOf');
  expect(JSON.stringify(RULE_OUTPUT_SCHEMA)).not.toContain('oneOf');
  expect(MEMORY_OUTPUT_SCHEMA).toMatchObject({ properties: { actions: { items: {
    anyOf: expect.arrayContaining([expect.objectContaining({
      required: ['type', 'memoryId', 'newEvidence', 'updatedContent'], additionalProperties: false,
    })]),
  } } } });
});
