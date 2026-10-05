import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { queryClient } from '../api/queryClient.js';
import type { ExecutableTask } from '@/types';
import * as api from '@/api/client';
import { t } from '@/i18n/index';

type TaskFilter = 'all' | 'active' | 'completed' | 'failed' | 'review' | 'skipped';

export function getTaskFilterOptions(): { value: TaskFilter; label: string }[] {
  return [
    { value: 'all', label: t('filter.all') },
    { value: 'active', label: t('filter.active') },
    { value: 'completed', label: t('filter.completed') },
    { value: 'failed', label: t('filter.failed') },
    { value: 'review', label: t('filter.review') },
    { value: 'skipped', label: t('filter.skipped') },
  ];
}

export function useTasks() {
  const state = useQuery({
    queryKey: ['tasks'],
    queryFn: ({ signal }) => api.fetchTasks(signal),
  }, queryClient);
  const tasks = computed<ExecutableTask[]>(() => state.data.value ?? []);
  const loading = state.isFetching;
  const error = computed(() => state.error.value?.message ?? '');
  async function refresh() { await state.refetch({ cancelRefetch: false }); }

  return {
    tasks,
    loading,
    error,
    refresh,
  };
}
