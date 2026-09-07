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

  async function refresh() {
    try {
      tasks.value = await api.fetchTasks(
        kindFilter ? { kind: kindFilter } : undefined,
      );
    } catch (e) {
      console.error('Fetch tasks failed', e);
    }
  }

  const activeCount = computed(() =>
    tasks.value.filter(t => t.stateCategory === 'active' || t.stateCategory === 'blocked').length);
  const completedCount = computed(() =>
    tasks.value.filter(t => t.stateCategory === 'completed').length);
  const failedCount = computed(() =>
    tasks.value.filter(t => t.stateCategory === 'failed').length);

  const filteredTasks = computed(() => {
    if (filter.value === 'all') return tasks.value.filter(t => t.stateCategory !== 'skipped');
    if (filter.value === 'active') return tasks.value.filter(t => t.stateCategory === 'active');
    if (filter.value === 'completed') return tasks.value.filter(t => t.stateCategory === 'completed');
    if (filter.value === 'failed') return tasks.value.filter(t => t.stateCategory === 'failed');
    if (filter.value === 'review') return tasks.value.filter(t => t.stateCategory === 'blocked');
    if (filter.value === 'skipped') return tasks.value.filter(t => t.stateCategory === 'skipped');
    return tasks.value;
  });

  return {
    tasks,
    filter,
    filteredTasks,
    activeCount,
    completedCount,
    failedCount,
    refresh,
  };
}
