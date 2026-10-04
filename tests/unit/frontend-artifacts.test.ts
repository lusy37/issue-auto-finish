// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { usePipeline } from '../../src/web/frontend/src/composables/usePipeline.js';
import type { IssueRecord } from '../../src/web/frontend/src/types/index.js';
import { newIssueRun } from '../../src/dag/contracts.js';

describe('产物元数据不可用时的页面行为', () => {
  it('元数据不可用时不猜测产物清单', () => {
    const pipeline = usePipeline();
    expect(pipeline.getPlanDocs()).toEqual([]);
    expect(pipeline.isEditableDoc('01-plan.md')).toBe(false);
    expect(pipeline.isEditableDoc('unknown.md')).toBe(false);
  });

  it.each([false, true])('按本轮是否含 UAT 展示对应报告：%s', enabled => {
    const run = newIssueRun();
    run.workflow.definition = { phaseIds: ['plan', 'review', 'build', 'verify', ...(enabled ? ['uat' as const] : [])] };
    const issue: IssueRecord = {
      run, phaseHistory: [], lifecycle: { kind: 'running', phase: 'build' }, branchName: 'iaf-42',
      demandSpec: { demandId: 'gh-42', sourceRef: { source: 'github-issue', externalId: '42' }, title: '测试需求', description: '测试产物展示', createdAt: '' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const docs = usePipeline().getPlanDocs(issue);
    expect(docs.some(doc => doc.file === '03-uat-report.md')).toBe(enabled);
    if (enabled) expect(docs.find(doc => doc.file === '03-uat-report.md')?.label).toBe('浏览器验收报告');
  });
});
