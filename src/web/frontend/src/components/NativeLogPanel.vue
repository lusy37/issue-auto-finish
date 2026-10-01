<script setup lang="ts">
import { computed, ref } from 'vue';
import { NButton } from 'naive-ui/es/button';
import { NEmpty } from 'naive-ui/es/empty';
import { NSelect } from 'naive-ui/es/select';
import { NSwitch } from 'naive-ui/es/switch';
import { Check, Terminal } from '@lucide/vue';
import type { AgentLogEntry, IssueLifecycle } from '@/types';
import { usePipeline } from '@/composables/usePipeline';
import { useAgentLogs } from '@/composables/useAgentLogs';
import { formatLogTime } from '@/utils/formatters';

const props = defineProps<{
  logs: AgentLogEntry[];
  lifecycle?: IssueLifecycle;
  autoScroll: boolean;
  debugMode: boolean;
}>();

const emit = defineEmits<{
  'update:autoScroll': [value: boolean];
  'update:debugMode': [value: boolean];
  clear: [];
}>();

const taskFilter = ref('all');
const attemptFilter = ref('all');
const { stateLabel, isTerminalState } = usePipeline();
const { agentLogLabel } = useAgentLogs();
const tasks = computed(() => [
  ...new Set(props.logs.flatMap((log) => (log.identity?.taskId ? [log.identity.taskId] : []))),
]);
const attempts = computed(() =>
  [
    ...new Set(
      props.logs.flatMap((log) =>
        log.identity?.attemptNo ? [String(log.identity.attemptNo)] : [],
      ),
    ),
  ].sort(),
);
const rows = computed(() =>
  props.logs.filter(
    (log) =>
      (taskFilter.value === 'all' || log.identity?.taskId === taskFilter.value) &&
      (attemptFilter.value === 'all' || String(log.identity?.attemptNo) === attemptFilter.value),
  ),
);

const taskOptions = computed(() => [
  { label: '全部任务', value: 'all' },
  ...tasks.value.map((value) => ({ label: value, value })),
]);
const attemptOptions = computed(() => [
  { label: '全部尝试', value: 'all' },
  ...attempts.value.map((value) => ({ label: `第 ${value} 次`, value })),
]);
</script>

<template>
  <section
    class="native-log-panel surface"
    aria-label="执行日志"
  >
    <header class="native-log-head">
      <div class="native-log-title">
        <Terminal :size="18" />
        <div>
          <h2>完整日志</h2>
          <p>按本次运行顺序展示执行器事件。</p>
        </div>
        <span class="native-log-count">{{ rows.length }} 条</span>
      </div>
      <div class="native-log-actions">
        <label>
          自动跟随
          <NSwitch
            :value="autoScroll"
            size="small"
            aria-label="日志自动跟随"
            @update:value="emit('update:autoScroll', $event)"
          />
        </label>
        <NButton
          quaternary
          size="small"
          :disabled="!logs.length"
          @click="emit('clear')"
        >
          清空
        </NButton>
        <NButton
          quaternary
          size="small"
          @click="$emit('update:debugMode', !debugMode)"
        >
          {{ debugMode ? '隐藏调试' : '显示调试' }}
        </NButton>
      </div>
    </header>
    <div class="native-log-toolbar">
      <NSelect
        v-model:value="taskFilter"
        size="small"
        :options="taskOptions"
        aria-label="按任务筛选日志"
      />
      <NSelect
        v-model:value="attemptFilter"
        size="small"
        :options="attemptOptions"
        aria-label="按尝试筛选日志"
      />
    </div>
    <div
      v-if="!rows.length"
      class="native-log-empty"
    >
      <NEmpty
        :description="
          logs.length
            ? '没有匹配的日志'
            : lifecycle && isTerminalState(lifecycle)
              ? `本次运行已结束：${stateLabel(lifecycle)}`
              : '等待执行器产生日志'
        "
      />
    </div>
    <div
      v-else
      class="native-log-body"
      role="log"
      aria-live="polite"
    >
      <article
        v-for="(log, index) in rows"
        :key="`${log.timestamp}-${index}`"
        class="native-log-row"
        :class="`native-log-${log.type}`"
      >
        <time>{{ formatLogTime(log.timestamp) }}</time>
        <span class="native-log-badge">{{ agentLogLabel(log.type) }}</span>
        <span
          v-if="log.phase"
          class="native-log-phase"
        >
          {{ log.phase }}
        </span>
        <span
          v-if="log.identity"
          class="native-log-task"
        >
          {{ log.identity.taskId }} · 第 {{ log.identity.attemptNo }} 次
        </span>
        <Check
          v-if="log.type === 'result' || log.type === 'tool_result'"
          :size="13"
          class="native-log-check"
        />
        <span class="native-log-message">{{ log.summary }}</span>
      </article>
    </div>
    <footer class="native-log-foot">
      <span>当前展示 {{ rows.length }} / {{ logs.length }} 条事件</span>
      <span>日志来自 Native 服务端本轮执行</span>
    </footer>
  </section>
</template>
