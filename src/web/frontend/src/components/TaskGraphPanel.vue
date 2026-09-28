<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Check, ChevronRight, Clock3, Code2, GitMerge, LockKeyhole, Terminal } from '@lucide/vue';
import { useIssueGraphs } from '@/composables/useIssueGraphs';
import ExecutionGraph from './ExecutionGraph.vue';
import type { IssueGraphs } from '../../../../shared/workflowGraphs.js';

const props = defineProps<{ issueNumber: number; stateVersion?: number }>();
const emit = defineEmits<{ 'task-selected': [task: IssueGraphs['tasks'][number] | undefined] }>();
const { graph, error, loading, refresh } = useIssueGraphs(props);
const selectedTaskId = ref('');

const tasks = computed(() => graph.value?.tasks ?? []);
const labels: Record<string, string> = {
  pending: '等待依赖',
  running: '执行中',
  'waiting-merge': '等待合并',
  merging: '正在集成',
  merged: '已合并',
  failed: '失败',
  uncertain: '结果待核对',
};
function status(task: IssueGraphs['tasks'][number]): string {
  if (task.status === 'merged')
    return task.success && task.merge?.stage === 'merged' ? '已合并' : '凭证待核对';
  if (
    task.status === 'pending' &&
    task.dependsOn.some((id) => tasks.value.find((t) => t.id === id)?.status !== 'merged')
  )
    return '等待前置任务';
  return labels[task.status ?? 'pending'];
}
const taskStatuses = computed(() =>
  Object.fromEntries(tasks.value.map((task) => [task.id, status(task)])),
);
const selectedTask = computed(
  () =>
    tasks.value.find((task) => task.id === selectedTaskId.value) ??
    tasks.value.find((task) => task.status === 'running') ??
    tasks.value[0],
);
const mergedCount = computed(() => tasks.value.filter((task) => task.status === 'merged').length);
const checkpointLabel = computed(() => {
  if (!graph.value?.checkpoint.exists) return '暂无检查点，等待计划进入执行。';
  return graph.value.checkpoint.next.length
    ? `检查点下一步：${graph.value.checkpoint.next.join('、')}`
    : '检查点已无后续节点';
});
const hasCheckpointTasks = computed(() =>
  Boolean(graph.value?.checkpoint.tasks.some((task) => task.interrupts.length || task.error)),
);

function selectTask(task: IssueGraphs['tasks'][number]) {
  selectedTaskId.value = task.id;
  emit('task-selected', task);
}
watch(selectedTask, (task) => emit('task-selected', task), { immediate: true });
</script>

<template>
  <div class="task-graph-panel">
    <section class="execution-surface">
      <header class="execution-head">
        <div>
          <div class="execution-eyebrow">BUILD / TASK GRAPH</div>
          <h3>构建任务图</h3>
        </div>
        <div class="execution-head-right">
          <div
            class="graph-legend"
            aria-label="任务状态图例"
          >
            <span>
              <i class="graph-dot merged"></i>
              已合并
            </span>
            <span>
              <i class="graph-dot running"></i>
              执行中
            </span>
            <span>
              <i class="graph-dot waiting"></i>
              等待
            </span>
            <span>
              <i class="graph-dot failed"></i>
              异常
            </span>
          </div>
          <button
            class="execution-refresh"
            type="button"
            :disabled="loading"
            @click="refresh"
          >
            {{ loading ? '读取中…' : '刷新图数据' }}
          </button>
        </div>
      </header>
      <div
        v-if="loading"
        class="execution-state"
        role="status"
      >
        正在读取本轮任务图…
      </div>
      <div
        v-else-if="error"
        class="execution-state execution-error"
        role="alert"
      >
        {{ error }}
      </div>
      <template v-else-if="graph">
        <div class="execution-meta">
          <span>计划 v{{ graph.planRevision }}</span>
          <span>构建 {{ graph.buildGeneration }}</span>
          <span>流程 {{ graph.workflowGeneration }}</span>
          <span>状态 {{ graph.lifecycle }}</span>
          <span class="execution-meta-lock">
            <LockKeyhole :size="11" />
            依赖只读
          </span>
        </div>
        <div class="graph-viewport">
          <ExecutionGraph
            v-if="tasks.length"
            :graph="graph.topology"
            :statuses="taskStatuses"
            :active="selectedTask ? [selectedTask.id] : []"
            variant="tasks"
            @select="
              (id) => {
                const task = tasks.find((item) => item.id === id);
                if (task) selectTask(task);
              }
            "
          />
          <div
            v-else
            class="graph-empty"
          >
            计划尚未生成构建任务
          </div>
        </div>
        <div class="graph-statusbar">
          <span>
            <GitMerge :size="14" />
            {{ mergedCount }} / {{ tasks.length }} 个任务已合并
          </span>
          <span>{{ checkpointLabel }}</span>
        </div>
        <section
          class="execution-log-panel"
          aria-label="检查点提示"
        >
          <header>
            <strong>
              <Terminal :size="14" />
              检查点提示
            </strong>
            <span>{{ hasCheckpointTasks ? '有待处理项' : '无待处理项' }}</span>
          </header>
          <template v-if="hasCheckpointTasks">
            <div
              v-for="checkpointTask in graph.checkpoint.tasks"
              :key="checkpointTask.id"
              class="execution-log-row"
            >
              <code>{{ checkpointTask.id }}</code>
              <span>
                {{
                  checkpointTask.error ||
                  (checkpointTask.interrupts.length ? '等待人工审核' : '检查点已记录')
                }}
              </span>
            </div>
          </template>
          <div
            v-else
            class="execution-log-empty"
          >
            当前无待处理检查点；运行过程请查看「完整日志」。
          </div>
        </section>
        <p
          v-if="graph.buildEntry === 'repair-integration'"
          class="task-graph-notice"
        >
          当前进入集成修复，第 {{ graph.repairRounds }} 轮；已保留原任务合并结果。
        </p>
        <details
          v-if="graph.repairReason"
          class="task-graph-details"
        >
          <summary>查看修复原因</summary>
          <p>{{ graph.repairReason }}</p>
        </details>
      </template>
    </section>

    <section
      v-if="graph && tasks.length"
      class="task-index surface"
    >
      <header class="section-head">
        <h2>任务清单</h2>
        <span class="muted text-xs">{{ tasks.length }} 个子任务</span>
      </header>
      <button
        v-for="task in tasks"
        :key="task.id"
        class="task-index-row"
        :class="{ active: selectedTask?.id === task.id }"
        :aria-pressed="selectedTask?.id === task.id"
        type="button"
        @click="selectTask(task)"
      >
        <span
          class="list-task-icon"
          :class="task.status"
        >
          <Check
            v-if="task.status === 'merged'"
            :size="17"
          />
          <Code2
            v-else-if="task.status === 'running'"
            :size="17"
          />
          <Clock3
            v-else
            :size="17"
          />
        </span>
        <span class="grow">
          <strong>{{ task.title }}</strong>
          <small>
            {{ task.id }} ·
            {{ task.dependsOn.length ? '依赖 ' + task.dependsOn.join('、') : '无前置依赖' }}
          </small>
        </span>
        <span
          class="task-list-status"
          :class="task.status"
        >
          {{ status(task) }}
        </span>
        <ChevronRight :size="15" />
      </button>
    </section>
  </div>
</template>
