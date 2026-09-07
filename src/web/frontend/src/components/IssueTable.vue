<script setup lang="ts">
import { ref, computed } from 'vue';
import type { ExecutableTask, IssueState, PhaseStatus, SystemStatus } from '@/types';
import { usePipeline } from '@/composables/usePipeline';
import { getTaskFilterOptions } from '@/composables/useTasks';
import { formatTime } from '@/utils/formatters';
import { t } from '@/i18n/index';

type SortField = 'taskId' | 'sourceState' | 'attempts' | 'updatedAt';
type SortDirection = 'asc' | 'desc';

const props = defineProps<{
  issues: ExecutableTask[];
  filter: string;
  systemStatus: SystemStatus | null;
}>();

const emit = defineEmits<{
  'update:filter': [value: string];
  select: [taskId: number];
  start: [number: number];
  retry: [number: number];
  restart: [number: number];
  cancel: [number: number];
}>();

const { stateLabel, stateClass } = usePipeline();

const sortField = ref<SortField>('updatedAt');
const sortDirection = ref<SortDirection>('desc');

function segmentClass(status: PhaseStatus): string {
  if (status === 'completed') return 'bg-green-500';
  if (status === 'in_progress' || status === 'gate_waiting') return 'bg-blue-500 animate-pulse';
  if (status === 'failed') return 'bg-red-500';
  return 'bg-gray-200';
}

function currentPhaseLabel(task: ExecutableTask): string {
  if (!task.phaseProgress) return '';
  const active = task.phaseProgress.find(p => p.status === 'in_progress' || p.status === 'gate_waiting');
  if (active) return active.label;
  const failed = task.phaseProgress.find(p => p.status === 'failed');
  if (failed) return failed.label;
  const allDone = task.phaseProgress.every(p => p.status === 'completed');
  if (allDone) return t('pipeline.allCompleted');
  return '';
}

function progressTooltip(task: ExecutableTask): string {
  if (!task.phaseProgress) return '';
  return task.phaseProgress.map(p => `${p.label}: ${t(`phase.status.${p.status}`)}`).join('\n');
}

const sortedIssues = computed(() => {
  const list = [...props.issues];
  const dir = sortDirection.value === 'asc' ? 1 : -1;
  return list.sort((a, b) => {
    const field = sortField.value;
    if (field === 'updatedAt') {
      return dir * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
    }
    if (field === 'taskId') {
      return dir * (Number(a.taskId) - Number(b.taskId));
    }
    if (field === 'attempts') {
      return dir * (a.attempts - b.attempts);
    }
    return dir * (a.sourceState ?? '').localeCompare(b.sourceState ?? '');
  });
});

function toggleSort(field: SortField) {
  if (sortField.value === field) {
    sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortField.value = field;
    sortDirection.value = field === 'updatedAt' ? 'desc' : 'asc';
  }
}
</script>

<template>
  <div>
    <div class="mb-4 flex items-center space-x-2">
      <span class="text-sm text-gray-600">{{ $t('table.filter') }}</span>
      <button
        v-for="f in getTaskFilterOptions()"
        :key="f.value"
        class="px-3 py-1 rounded-full text-xs font-medium transition-colors"
        :class="filter === f.value ? 'bg-gray-800 text-white' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'"
        @click="emit('update:filter', f.value)"
      >{{ f.label }}</button>
    </div>

    <div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      <table class="w-full">
        <thead class="bg-gray-50 border-b border-gray-200">
          <tr>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer select-none hover:text-gray-700" @click="toggleSort('taskId')">
              IID <span v-if="sortField === 'taskId'">{{ sortDirection === 'asc' ? '&#9650;' : '&#9660;' }}</span>
            </th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{{ $t('table.title') }}</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer select-none hover:text-gray-700" @click="toggleSort('sourceState')">
              {{ $t('table.state') }} <span v-if="sortField === 'sourceState'">{{ sortDirection === 'asc' ? '&#9650;' : '&#9660;' }}</span>
            </th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{{ $t('table.progress') }}</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer select-none hover:text-gray-700" @click="toggleSort('attempts')">
              {{ $t('table.retries') }} <span v-if="sortField === 'attempts'">{{ sortDirection === 'asc' ? '&#9650;' : '&#9660;' }}</span>
            </th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer select-none hover:text-gray-700" @click="toggleSort('updatedAt')">
              {{ $t('table.updatedAt') }} <span v-if="sortField === 'updatedAt'">{{ sortDirection === 'asc' ? '&#9650;' : '&#9660;' }}</span>
            </th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{{ $t('table.actions') }}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-if="sortedIssues.length === 0">
            <td colspan="7" class="px-4 py-8 text-center text-gray-400">{{ $t('table.empty') }}</td>
          </tr>
          <tr
            v-for="task in sortedIssues"
            :key="task.taskId"
            class="hover:bg-gray-50 cursor-pointer transition-colors"
            @click="emit('select', Number(task.taskId))"
          >
            <td class="px-4 py-3 text-sm font-mono text-gray-700">
              <a
                :href="systemStatus ? `${systemStatus.config.githubBaseUrl}/${systemStatus.config.repository}/issues/${task.taskId}` : '#'"
                target="_blank" rel="noopener"
                class="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center"
                @click.stop :title="$t('table.viewInGitHub')"
              >
                #{{ task.taskId }}
                <svg class="w-3 h-3 ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
              </a>
            </td>
            <td class="px-4 py-3 text-sm text-gray-800 max-w-xs truncate">{{ task.title }}</td>
            <td class="px-4 py-3">
              <span class="px-2 py-1 rounded-full text-xs font-medium" :class="stateClass((task.sourceState ?? 'pending') as IssueState)">{{ task.displayLabel ?? stateLabel((task.sourceState ?? 'pending') as IssueState) }}</span>
            </td>
            <td class="px-4 py-3">
              <div v-if="task.phaseProgress" class="flex items-center gap-2 min-w-[140px]" :title="progressTooltip(task)">
                <div class="flex h-2 rounded-full overflow-hidden flex-1 max-w-[100px] bg-gray-100">
                  <div
                    v-for="phase in task.phaseProgress"
                    :key="phase.name"
                    class="flex-1 transition-colors duration-300"
                    :class="segmentClass(phase.status)"
                  />
                </div>
                <span class="text-xs text-gray-500 truncate max-w-[80px]">{{ currentPhaseLabel(task) }}</span>
              </div>
            </td>
            <td class="px-4 py-3 text-sm text-gray-600">{{ task.attempts }}</td>
            <td class="px-4 py-3 text-sm text-gray-500">{{ formatTime(task.updatedAt) }}</td>
            <td class="px-4 py-3">
              <div class="flex space-x-2" @click.stop>
                <button
                  v-if="task.sourceState === 'skipped'"
                  class="px-2 py-1 bg-green-500 text-white text-xs rounded hover:bg-green-600"
                  @click="emit('start', Number(task.taskId))"
                >{{ $t('table.start') }}</button>
                <button
                  v-if="task.sourceState === 'failed'"
                  class="px-2 py-1 bg-blue-500 text-white text-xs rounded hover:bg-blue-600"
                  @click="emit('retry', Number(task.taskId))"
                >{{ $t('table.retry') }}</button>
                <button
                  v-if="task.sourceState !== 'skipped'"
                  class="px-2 py-1 bg-yellow-100 text-yellow-700 text-xs rounded hover:bg-yellow-200"
                  @click="emit('restart', Number(task.taskId))"
                >{{ $t('table.restart') }}</button>
                <button
                  class="px-2 py-1 bg-red-100 text-red-600 text-xs rounded hover:bg-red-200"
                  @click="emit('cancel', Number(task.taskId))"
                >{{ $t('table.cancel') }}</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
