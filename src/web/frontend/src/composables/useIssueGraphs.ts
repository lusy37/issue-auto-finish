import { ref, watch, onScopeDispose } from 'vue';
import * as api from '@/api/client';
import type { IssueGraphs } from '../../../../shared/workflowGraphs.js';

export function useIssueGraphs(props: { issueNumber: number; stateVersion?: number }) {
  const graph = ref<IssueGraphs>();
  const error = ref('');
  const loading = ref(false);
  let request = 0;
  async function refresh() {
    const current = ++request;
    const number = props.issueNumber;
    // 新轮次加载期间清空旧图，避免短暂展示上一次构建。
    graph.value = undefined;
    error.value = '';
    loading.value = true;
    try {
      const result = await api.fetchIssueGraphs(number);
      if (current !== request) return;
      if (result.issueNumber !== number || result.version < (props.stateVersion ?? 0)) {
        error.value = '图数据已过期，请刷新。';
        return;
      }
      graph.value = result;
    } catch (failure) { if (current === request) error.value = (failure as Error).message; }
    finally { if (current === request) loading.value = false; }
  }
  watch(() => [props.issueNumber, props.stateVersion], refresh, { immediate: true, flush: 'sync' });
  onScopeDispose(() => { request++; });
  return { graph, error, loading, refresh };
}
