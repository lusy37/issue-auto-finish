<script setup lang="ts">
import { computed, h, ref, watch } from 'vue';
import {
  NButton,
  NDataTable,
  NEmpty,
  NInput,
  NSelect,
  NTab,
  NTabs,
  NTag,
  type DataTableColumns,
} from 'naive-ui';
import { ArrowUpRight, ListFilter, Search, X } from '@lucide/vue';
import type { ExecutableTask, PhaseStatus } from '@/types';
import { getTaskFilterOptions } from '@/composables/useTasks';
import { formatTime } from '@/utils/formatters';
import { usePipeline } from '@/composables/usePipeline';

const props = defineProps<{ tasks: ExecutableTask[]; loading?: boolean; error?: string }>();
const emit = defineEmits<{ select: [number] }>();
const filter = ref('all');
const search = ref('');
const kind = ref<string | null>(null);
const page = ref(1);
const pageSize = 8;
const { stateLabel } = usePipeline();
const kindOptions = [{ label: 'Issue', value: 'issue' }];

const filters = computed(() =>
  getTaskFilterOptions().map((item) => ({
    ...item,
    count:
      item.value === 'all'
        ? props.tasks.length
        : props.tasks.filter(
            (task) => item.value === task.stateCategory || item.value === task.lifecycle.kind,
          ).length,
  })),
);
const rows = computed(() =>
  props.tasks.filter((task) => {
    const text = `${task.taskId} ${task.title} ${task.branchName ?? ''}`.toLowerCase();
    const matchesFilter =
      filter.value === 'all' ||
      task.stateCategory === filter.value ||
      task.lifecycle.kind === filter.value;
    return (
      matchesFilter &&
      (!kind.value || task.kind === kind.value) &&
      text.includes(search.value.trim().toLowerCase())
    );
  }),
);
watch([filter, search, kind], () => {
  page.value = 1;
});

function segmentClass(status: PhaseStatus): string {
  if (status === 'completed') return 'prototype-phase-complete';
  if (status === 'in_progress' || status === 'gate_waiting') return 'prototype-phase-current';
  if (status === 'failed') return 'prototype-phase-failed';
  return '';
}

function open(task: ExecutableTask) {
  emit('select', Number(task.taskId));
}

const columns: DataTableColumns<ExecutableTask> = [
  {
    title: '任务',
    key: 'title',
    minWidth: 330,
    render: (task) =>
      h('div', { class: 'prototype-table-issue' }, [
        h(
          NButton,
          { text: true, class: 'prototype-issue-link', onClick: () => open(task) },
          { default: () => task.title },
        ),
        h('div', { class: 'prototype-issue-meta' }, [
          h('span', { class: 'prototype-mono' }, `#${task.taskId}`),
          h('span', task.branchName || '工作台'),
          h(NTag, { size: 'small', bordered: false }, { default: () => task.kind }),
        ]),
      ]),
  },
  {
    title: '状态',
    key: 'status',
    width: 125,
    render: (task) =>
      h(
        NTag,
        {
          round: true,
          bordered: false,
          type:
            task.lifecycle.kind === 'failed'
              ? 'error'
              : task.lifecycle.kind === 'completed'
                ? 'success'
                : task.lifecycle.kind === 'waiting'
                  ? 'warning'
                  : 'info',
        },
        { default: () => task.displayLabel ?? stateLabel(task.lifecycle) },
      ),
  },
  {
    title: '执行阶段',
    key: 'phase',
    width: 165,
    render: (task) =>
      h('div', { class: 'prototype-phase-cell' }, [
        h(
          'div',
          { class: 'prototype-phase-track', 'aria-hidden': 'true' },
          (task.phaseProgress ?? []).map((phase) =>
            h('span', { class: segmentClass(phase.status) }),
          ),
        ),
        h(
          'div',
          { class: 'prototype-phase-caption' },
          task.phaseProgress?.find(
            (phase) => phase.status === 'in_progress' || phase.status === 'gate_waiting',
          )?.label ?? '等待阶段',
        ),
      ]),
  },
  {
    title: '最近更新',
    key: 'updatedAt',
    width: 120,
    render: (task) =>
      h('span', { class: 'prototype-muted prototype-text-xs' }, formatTime(task.updatedAt)),
  },
  {
    title: '',
    key: 'action',
    width: 60,
    render: (task) =>
      h(
        NButton,
        {
          quaternary: true,
          circle: true,
          size: 'small',
          'aria-label': `查看任务 ${task.taskId}`,
          onClick: () => open(task),
        },
        { icon: () => h(ArrowUpRight, { size: 17 }) },
      ),
  },
];
</script>

<template>
  <section
    class="prototype-task-table"
    aria-label="任务列表"
  >
    <div class="prototype-table-filter-top">
      <NTabs
        v-model:value="filter"
        type="line"
        size="small"
        class="prototype-task-tabs"
      >
        <NTab
          v-for="item in filters"
          :key="item.value"
          :name="item.value"
        >
          <span>{{ item.label }}</span>
          <span class="prototype-filter-count">{{ item.count }}</span>
        </NTab>
      </NTabs>
    </div>
    <div class="prototype-table-search-row">
      <NInput
        v-model:value="search"
        placeholder="搜索标题、编号或分支…"
        clearable
        class="prototype-search-input"
        aria-label="搜索任务"
      >
        <template #prefix><Search :size="16" /></template>
      </NInput>
      <NSelect
        v-model:value="kind"
        :options="kindOptions"
        clearable
        placeholder="全部类型"
        aria-label="任务类型"
        class="prototype-kind-select"
      >
        <template #arrow><ListFilter :size="15" /></template>
      </NSelect>
      <NButton
        v-if="search || kind || filter !== 'all'"
        quaternary
        size="small"
        @click="
          filter = 'all';
          search = '';
          kind = null;
        "
      >
        <template #icon><X :size="14" /></template>
        清除筛选
      </NButton>
      <span class="prototype-muted prototype-table-result">{{ rows.length }} 个结果</span>
    </div>
    <div
      v-if="loading"
      class="prototype-table-state"
      role="status"
      aria-busy="true"
    >
      正在读取任务与最新进度…
    </div>
    <div
      v-else-if="error"
      class="prototype-table-state prototype-table-error"
      role="alert"
    >
      {{ error }}
    </div>
    <div
      v-else
      class="prototype-desktop-table"
      id="task-results"
    >
      <NDataTable
        :columns="columns"
        :data="rows"
        :row-key="(row) => row.taskId"
        :bordered="false"
        :single-line="true"
        :scroll-x="760"
        :pagination="{ page, pageSize, showSizePicker: false }"
        :paginate-single-page="false"
        @update:page="page = $event"
      >
        <template #empty>
          <NEmpty description="没有匹配的任务">
            <template #extra>
              <NButton
                size="small"
                @click="
                  filter = 'all';
                  search = '';
                  kind = null;
                "
              >
                清除筛选
              </NButton>
            </template>
          </NEmpty>
        </template>
      </NDataTable>
    </div>
    <footer class="prototype-table-foot">
      <span>共 {{ rows.length }} 个任务 · 最近更新优先</span>
      <span>点击任务标题查看详情</span>
    </footer>
  </section>
</template>
