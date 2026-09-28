import { ref, computed } from 'vue';
import type { ExecutableTask, TaskKind } from '@/types';
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
  const tasks = ref<ExecutableTask[]>([]);
  const filter = ref<TaskFilter>('all');
  const query = ref('');
  const loading = ref(false);
  const error = ref('');
  let requestId = 0;

  async function refresh() {
    const current = ++requestId;
    loading.value = true;
    error.value = '';
    try {
      const result = await api.fetchTasks(kindFilter ? { kind: kindFilter } : undefined);
      if (current === requestId) tasks.value = result;
    } catch (e) {
      if (current === requestId) {
        error.value = (e as Error).message;
        console.error('Fetch tasks failed', e);
      }
    } finally {
      if (current === requestId) loading.value = false;
    }
  }

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
                  ? task.stateCategory === 'blocked'
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
