import { buildReviewFeedbackResumePrompt } from '../../src/prompts/templates.js';
import { describe, it, expect } from 'vitest';
import { StateGraph, StateSchema, START, END } from '@langchain/langgraph';
import { z } from 'zod';
import { parseJsonOutput } from '../../src/prompts/parseJsonOutput.js';
import { withWorkbenchLabels } from '../../src/clients/IssueLabels.js';
import { taskTopology } from '../../src/dag/taskTopology.js';
import { MAX_PLAN_TASKS, taskGraphRecursionLimit } from '../../src/dag/limits.js';
import { GitHubApiError } from '../../src/errors/ApiError.js';
import { task } from '../helpers/dag-repository.js';

describe('修复后的公共契约', () => {
  it('恢复 SDK 会话仍携带完整上版计划与审核反馈', () => {
    const snapshot = '完整计划正文'.repeat(5000);
    const prompt = buildReviewFeedbackResumePrompt([{ round: 1, timestamp: '2026-09-20', feedback: '补充取消测试', planSnapshot: snapshot }], '补充需求');
    expect(prompt).toContain(snapshot);
    expect(prompt).toContain('补充取消测试');
    expect(prompt).toContain('补充需求');
  });
  it.each(['{"actions":[]}', '```json\n{"actions":[]}\n```'])('合法原始和围栏 JSON：%s', output => {
    expect(parseJsonOutput(output)).toEqual({ actions: [] });
  });
  it.each(['', '无操作', '```json\n{}\n```\n```json\n{}\n```', '{actions: []}'])('非法输出必须报错：%s', output => {
    expect(() => parseJsonOutput(output)).toThrow();
  });
  it('只替换精确根标签与工作台命名空间', () => {
    expect(withWorkbenchLabels(['auto-finish-tools', 'bug', 'auto-finish', 'auto-finish:processing'], ['auto-finish:done'])).toEqual(['auto-finish-tools', 'bug', 'auto-finish:done']);
  });
  it.each([[30000, true], [30001, false], [60000, false]] as const)('限流等待 %i 毫秒的自动重试资格', (wait, expected) => {
    expect(new GitHubApiError(429, '限流', undefined, true, wait).isRetryable).toBe(expected);
  });
  it.each([1, MAX_PLAN_TASKS])('%i 节点长链在真实图步数上限内完成', async count => {
    const definitions = Array.from({ length: count }, (_, i) => task(`t${i}`, i ? [`t${i - 1}`] : []));
    const visited: string[] = [];
    const graph = new StateGraph(new StateSchema({ marker: z.number() })).addNode(Object.fromEntries(definitions.map(t => [t.id, async () => { visited.push(t.id); return {}; }])));
    const topology = taskTopology(definitions);
    for (const join of topology.joins) graph.addEdge(join.sources.length ? join.sources : START, join.target);
    for (const leaf of topology.leaves) graph.addEdge(leaf, END);
    await graph.compile().invoke({ marker: 1 }, { recursionLimit: taskGraphRecursionLimit(count) });
    expect(visited).toEqual(definitions.map(t => t.id));
  });
});
