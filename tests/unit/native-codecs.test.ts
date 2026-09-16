import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertIssueRunShape } from '../../src/dag/codecs/IssueRunCodec.js';
import { decodePlanContent } from '../../src/dag/codecs/TaskPlanCodec.js';
import { newIssueRun } from '../../src/dag/contracts.js';
import { assertIssueRunInvariants } from '../../src/dag/invariants.js';
import { decodeReviewDecision } from '../../src/orchestration/codecs/WorkflowCodec.js';

describe('Native 运行时 Codec 边界', () => {
  it('计划 Codec 只处理输入形状和规范化，DAG 规则由普通 invariant 拒绝', () => {
    const valid = {
      title: ' 计划 ',
      description: ' 实施说明 ',
      acceptanceCriteria: [' 验收通过 '],
      tasks: [{
        id: 'build',
        title: ' 实现 ',
        instructions: ' 完成代码 ',
        acceptanceCriteria: [' 测试通过 '],
        dependsOn: [],
      }],
    };
    expect(decodePlanContent(valid).title).toBe('计划');
    expect(() => decodePlanContent({ ...valid, title: 42 })).toThrow();
    expect(() => decodePlanContent({
      ...valid,
      tasks: [{ ...valid.tasks[0], dependsOn: ['missing'] }],
    })).toThrow('不存在');
  });

  it('运行 Codec 拒绝字段形状损坏，普通 invariant 拒绝跨字段凭证损坏', () => {
    const malformed = { ...newIssueRun(), retryUsed: { build: -1 } };
    expect(() => assertIssueRunShape(malformed)).toThrow();

    const inconsistent = newIssueRun();
    inconsistent.planRevision = 1;
    assertIssueRunShape(inconsistent);
    expect(() => assertIssueRunInvariants(inconsistent, 1)).toThrow('摘要');
  });

  it('审核 Codec 校验外部枚举，反馈约束由普通 invariant 处理', () => {
    expect(decodeReviewDecision({ planRevision: 1, action: 'approve' })).toEqual({
      planRevision: 1,
      action: 'approve',
    });
    expect(() => decodeReviewDecision({ planRevision: 1, action: 'skip' })).toThrow();
    expect(() => decodeReviewDecision({ planRevision: 1, action: 'reject' })).toThrow('反馈');
  });
});

it('领域状态文件不直接依赖 Zod', () => {
  for (const file of ['src/dag/contracts.ts', 'src/dag/invariants.ts', 'src/orchestration/WorkflowState.ts']) {
    const source = fs.readFileSync(path.resolve(file), 'utf8');
    expect(source).not.toContain("from 'zod'");
    expect(source).not.toContain('z.object(');
  }
});
