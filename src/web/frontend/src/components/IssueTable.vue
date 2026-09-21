<script setup lang="ts">
import { ref, computed } from 'vue';
import type { ExecutableTask, PhaseStatus, SystemStatus } from '@/types';
import { usePipeline } from '@/composables/usePipeline';
import { getTaskFilterOptions } from '@/composables/useTasks';
import { formatTime } from '@/utils/formatters';
import { t } from '@/i18n/index';

type SortField = 'taskId' | 'lifecycle' | 'attempts' | 'updatedAt';
type SortDirection = 'asc' | 'desc';

const props = defineProps<{
  issues: ExecutableTask[];
  filter: string;
  query: string;
  systemStatus: SystemStatus | null;
  loading?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  'update:filter': [value: string];
  'update:query': [value: string];
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

function activePhaseLabel(task: ExecutableTask): string {
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
    return dir * a.lifecycle.kind.localeCompare(b.lifecycle.kind);
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
  <section class="issue-table-panel" aria-label="任务列表">
    <div class="issue-table-toolbar">
      <div class="issue-filter-tabs" role="tablist" :aria-label="$t('table.filter')">
      <button
        v-for="f in getTaskFilterOptions()"
        :key="f.value"
        class="issue-filter-tab"
        :class="filter === f.value ? 'is-active' : ''"
        role="tab"
        :aria-selected="filter === f.value"
        @click="emit('update:filter', f.value)"
      >{{ f.label }}</button>
      </div>
      <div class="issue-search-row">
        <label class="sr-only" for="issue-search">搜索任务</label>
        <input
          id="issue-search"
          :value="query"
          type="search"
          class="issue-search-input"
          placeholder="搜索标题、编号或分支…"
          @input="emit('update:query', ($event.target as HTMLInputElement).value)"
        />
        <button v-if="query" type="button" class="issue-clear-button" @click="emit('update:query', '')">清除</button>
      </div>
    </div>

    <div v-if="loading" class="issue-table-state" aria-busy="true" role="status">正在读取任务与最新进度…</div>
    <div v-else-if="error" class="issue-table-state issue-table-error" role="alert">
      <strong>暂时无法读取任务</strong><span>{{ error }}</span>
    </div>
    <div v-else class="issue-table-scroll">
      <table class="issue-table">
        <thead>
          <tr>
            <th class="issue-table-heading" @click="toggleSort('taskId')">
              IID <span v-if="sortField === 'taskId'">{{ sortDirection === 'asc' ? '&#9650;' : '&#9660;' }}</span>
            </th>
            <th class="issue-table-heading">{{ $t('table.title') }}</th>
            <th class="issue-table-heading" @click="toggleSort('lifecycle')">
              {{ $t('table.state') }} <span v-if="sortField === 'lifecycle'">{{ sortDirection === 'asc' ? '&#9650;' : '&#9660;' }}</span>
            </th>
            <th class="issue-table-heading">{{ $t('table.progress') }}</th>
            <th class="issue-table-heading" @click="toggleSort('attempts')">
              {{ $t('table.retries') }} <span v-if="sortField === 'attempts'">{{ sortDirection === 'asc' ? '&#9650;' : '&#9660;' }}</span>
            </th>
            <th class="issue-table-heading" @click="toggleSort('updatedAt')">
              {{ $t('table.updatedAt') }} <span v-if="sortField === 'updatedAt'">{{ sortDirection === 'asc' ? '&#9650;' : '&#9660;' }}</span>
            </th>
            <th class="issue-table-heading">{{ $t('table.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="sortedIssues.length === 0">
            <td colspan="7" class="issue-table-empty">{{ query ? '没有匹配的任务，请调整搜索条件。' : $t('table.empty') }}</td>
          </tr>
          <tr
            v-for="task in sortedIssues"
            :key="task.taskId"
            class="issue-table-row"
            @click="emit('select', Number(task.taskId))"
          >
            <td class="issue-table-cell issue-id-cell">
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
            <td class="issue-table-cell issue-title-cell" :title="task.title">{{ task.title }}</td>
            <td class="issue-table-cell">
              <span class="issue-state-pill" :class="stateClass(task.lifecycle)">{{ task.displayLabel ?? stateLabel(task.lifecycle) }}</span>
            </td>
            <td class="issue-table-cell">
              <div v-if="task.phaseProgress" class="issue-progress" :title="progressTooltip(task)">
                <div class="issue-progress-track">
                  <div
                    v-for="phase in task.phaseProgress"
                    :key="phase.name"
                    class="flex-1 transition-colors duration-300"
                    :class="segmentClass(phase.status)"
                  />
                </div>
                <span class="issue-progress-label">{{ activePhaseLabel(task) }}</span>
              </div>
            </td>
            <td class="issue-table-cell issue-muted-cell">{{ task.attempts }}</td>
            <td class="issue-table-cell issue-muted-cell">{{ formatTime(task.updatedAt) }}</td>
            <td class="issue-table-cell">
              <div class="issue-actions" @click.stop>
                <button
                  v-if="task.lifecycle.kind === 'skipped'"
                  class="issue-action issue-action-primary"
                  @click="emit('start', Number(task.taskId))"
                >{{ $t('table.start') }}</button>
                <button
                  v-if="task.lifecycle.kind === 'failed'"
                  class="issue-action issue-action-primary"
                  @click="emit('retry', Number(task.taskId))"
                >{{ $t('table.retry') }}</button>
                <button
                  v-if="task.lifecycle.kind !== 'skipped'"
                  class="issue-action issue-action-warning"
                  @click="emit('restart', Number(task.taskId))"
                >{{ $t('table.restart') }}</button>
                <button
                  class="issue-action issue-action-danger"
                  @click="emit('cancel', Number(task.taskId))"
                >{{ $t('table.cancel') }}</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <footer class="issue-table-footer"><span>共 {{ sortedIssues.length }} 个任务</span><span>点击任务查看执行详情</span></footer>
  </section>
</template>
