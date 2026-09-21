// @vitest-environment happy-dom
import { it, expect, vi, afterEach } from 'vitest';
import { effectScope, reactive } from 'vue';
import { useIssueGraphs } from '../../src/web/frontend/src/composables/useIssueGraphs.js';
import { repairProgress } from '../../src/web/frontend/src/composables/repairProgress.js';
import { usePipeline, loadPipelineMeta } from '../../src/web/frontend/src/composables/usePipeline.js';
import type { IssueGraphs } from '../../src/shared/workflowGraphs.js';
import type { IssueRecord } from '../../src/web/frontend/src/types/index.js';
import { newIssueRun } from '../../src/dag/contracts.js';
import * as api from '../../src/web/frontend/src/api/client.js';
vi.mock('../../src/web/frontend/src/api/client.js', () => ({ fetchIssueGraphs: vi.fn(), fetchPipelineMeta: vi.fn() }));
afterEach(() => vi.clearAllMocks());

it('旧 Issue 和旧记录版本的图响应不能覆盖新视图', async () => {
  const pending: Array<(value: IssueGraphs) => void> = [];
  vi.mocked(api.fetchIssueGraphs).mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  const props = reactive({ issueNumber: 1, stateVersion: 5 });
  const scope = effectScope();
  const state = scope.run(() => useIssueGraphs(props))!;
  const value = (issueNumber: number, version: number): IssueGraphs => ({ issueNumber, version, planRevision: 1, buildGeneration: 1, workflowGeneration: 1, threadId: 'test', lifecycle: 'ready', buildEntry: 'task-graph', repairRounds: 0, phaseIds: [], workflow: { nodes: [], edges: [] }, checkpoint: { exists: false, next: [], tasks: [] }, topology: { nodes: [], edges: [] }, tasks: [] });
  try {
    props.issueNumber = 2;
    pending[1](value(2, 5)); await Promise.resolve();
    pending[0](value(1, 10)); await Promise.resolve();
    expect(state.graph.value?.issueNumber).toBe(2);
    props.stateVersion = 6;
    expect(state.graph.value).toBeUndefined();
    pending[2](value(2, 5)); await Promise.resolve();
    expect(state.graph.value).toBeUndefined();
    expect(state.error.value).toContain('过期');
  } finally { scope.stop(); }
});

it('元数据失败后可重试，并发只发一次；本轮阶段优先', async () => {
  const fetch = vi.mocked(api.fetchPipelineMeta);
  fetch.mockRejectedValueOnce(new Error('模拟断网'));
  await Promise.all([loadPipelineMeta(), loadPipelineMeta()]);
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValueOnce({ modes: {} });
  await loadPipelineMeta();
  expect(fetch).toHaveBeenCalledTimes(2);
  const run = newIssueRun(); run.workflow.definition = { phaseIds: ['plan', 'review', 'build', 'verify'] };
  const issue: IssueRecord = { run, lifecycle: { kind: 'running', phase: 'build' }, branchName: 'iaf-2', demandSpec: { demandId: '2', sourceRef: { source: 'github-issue', externalId: '2' }, title: '需求', description: '测试' }, createdAt: '', updatedAt: '' };
  expect(usePipeline().getPhaseNames(issue)).not.toContain('uat');
  expect(usePipeline().isEditableDoc('01-plan.md')).toBe(false);
  run.repairRounds = 2; run.buildEntry = 'repair-integration';
  expect(repairProgress(JSON.parse(JSON.stringify(issue)), 3)).toMatchObject({ iteration: 2, active: true, lastPassed: false });
  issue.lifecycle = { kind: 'paused', phase: 'build' };
  expect(repairProgress(issue, 3)?.active).toBe(false);
});
