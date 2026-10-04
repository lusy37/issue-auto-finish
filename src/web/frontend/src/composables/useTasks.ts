import { ref, computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { queryClient } from '../api/queryClient.js';
import type { ExecutableTask, TaskKind } from '@/types';
import { isReviewWaiting } from '@/adapters/issueflowViewModel';
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

export function useTasks(kindFilter?: TaskKind) {
  const state = useQuery({
    queryKey: ['tasks', kindFilter ?? 'all'],
    queryFn: ({ signal }) => api.fetchTasks(kindFilter ? { kind: kindFilter } : undefined, signal),
  }, queryClient);
  const tasks = computed<ExecutableTask[]>(() => state.data.value ?? []);
  const filter = ref<TaskFilter>('all');
  const query = ref('');
  const loading = state.isFetching;
  const error = computed(() => state.error.value?.message ?? '');
  async function refresh() { await state.refetch({ cancelRefetch: false }); }

  const activeCount = computed(
    () =>
      tasks.value.filter((t) => t.stateCategory === 'active' || t.stateCategory === 'blocked')
        .length,
  );
  const completedCount = computed(
    () => tasks.value.filter((t) => t.stateCategory === 'completed').length,
  );
  const failedCount = computed(
    () => tasks.value.filter((t) => t.stateCategory === 'failed').length,
  );

  const filteredTasks = computed(() => {
    const keyword = query.value.trim().toLowerCase();
    return tasks.value.filter((task) => {
      const matchesFilter =
        filter.value === 'all'
          ? task.stateCategory !== 'skipped'
          : filter.value === 'active'
            ? task.stateCategory === 'active'
            : filter.value === 'completed'
              ? task.stateCategory === 'completed'
              : filter.value === 'failed'
                ? task.stateCategory === 'failed'
                : filter.value === 'review'
                  ? isReviewWaiting(task.lifecycle)
                  : task.stateCategory === 'skipped';
      if (!matchesFilter || !keyword) return matchesFilter;
      return `${task.taskId} ${task.title} ${task.displayLabel ?? ''} ${task.branchName ?? ''}`
        .toLowerCase()
        .includes(keyword);
    });
  });

  return {
    tasks,
    filter,
    query,
    filteredTasks,
    activeCount,
    completedCount,
    failedCount,
    loading,
    error,
    refresh,
  };
}
