import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { queryClient } from '../api/queryClient.js';
import * as api from '@/api/client';

export function useIssueGraphs(props: { issueNumber: number; stateVersion?: number }) {
  const state = useQuery({
    queryKey: computed(() => ['issue', props.issueNumber, 'graphs', props.stateVersion ?? 0]),
    queryFn: async ({ signal }) => {
      const number = props.issueNumber;
      const version = props.stateVersion ?? 0;
      const graph = await api.fetchIssueGraphs(number, signal);
      if (graph.issueNumber !== number || graph.version < version)
        throw new Error('图数据已过期，请刷新。');
      return graph;
    },
    enabled: computed(() => props.issueNumber > 0),
  }, queryClient);
  return {
    graph: state.data,
    error: computed(() => state.error.value?.message ?? ''),
    loading: state.isFetching,
    refresh: async () => { await state.refetch({ cancelRefetch: false }); },
  };
}
