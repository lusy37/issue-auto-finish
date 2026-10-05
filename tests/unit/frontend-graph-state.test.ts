// @vitest-environment happy-dom
import { it, expect, vi, afterEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { queryClient } from '../../src/web/frontend/src/api/queryClient.js';
import { effectScope, reactive } from 'vue';
import { useIssueGraphs } from '../../src/web/frontend/src/composables/useIssueGraphs.js';
import type { IssueGraphs } from '../../src/shared/workflowGraphs.js';
import * as api from '../../src/web/frontend/src/api/client.js';
vi.mock('../../src/web/frontend/src/api/client.js', () => ({ fetchIssueGraphs: vi.fn() }));
afterEach(() => { queryClient.clear(); vi.clearAllMocks(); });

it('旧 Issue 和旧记录版本的图响应不能覆盖新视图', async () => {
  const pending: Array<(value: IssueGraphs) => void> = [];
  vi.mocked(api.fetchIssueGraphs).mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  const props = reactive({ issueNumber: 1, stateVersion: 5 });
  const scope = effectScope();
  const state = scope.run(() => useIssueGraphs(props))!;
  const value = (issueNumber: number, version: number): IssueGraphs => ({ issueNumber, version, planRevision: 1, buildGeneration: 1, workflowGeneration: 1, threadId: 'test', lifecycle: 'ready', buildEntry: 'task-graph', repairRounds: 0, phaseIds: [], workflow: { nodes: [], edges: [] }, checkpoint: { exists: false, next: [], tasks: [] }, topology: { nodes: [], edges: [] }, tasks: [] });
  try {
    props.issueNumber = 2;
    await flushPromises();
    pending[1](value(2, 5)); await flushPromises();
    pending[0](value(1, 10)); await flushPromises();
    expect(state.graph.value?.issueNumber).toBe(2);
    props.stateVersion = 6;
    await flushPromises();
    expect(state.graph.value).toBeUndefined();
    pending[2](value(2, 5)); await flushPromises();
    expect(state.graph.value).toBeUndefined();
    expect(state.error.value).toContain('过期');
  } finally { scope.stop(); }
});
