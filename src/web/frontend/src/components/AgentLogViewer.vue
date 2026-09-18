<script setup lang="ts">
import { ref, computed } from "vue";
import type { AgentLogEntry, IssueLifecycle } from '@/types';
import { usePipeline } from '@/composables/usePipeline';
import { useAgentLogs } from '@/composables/useAgentLogs';
import { formatLogTime } from '@/utils/formatters';

const props = defineProps<{
  logs: AgentLogEntry[];
  lifecycle?: IssueLifecycle;
}>();

const emit = defineEmits<{
  clear: [];
}>();

const autoScroll = defineModel<boolean>('autoScroll', { default: true });
const debugMode = defineModel<boolean>('debugMode', { default: false });

const { stateLabel, isTerminalState } = usePipeline();
const { agentLogContainer, agentLogLabel } = useAgentLogs();
const taskFilter = ref(''), attemptFilter = ref('');
const tasks = computed(() => [...new Set(props.logs.flatMap(log => log.identity?.taskId ? [log.identity.taskId] : []))]);
const filteredLogs = computed(() => props.logs.filter(log => (!taskFilter.value || log.identity?.taskId === taskFilter.value) && (!attemptFilter.value || log.identity?.attemptNo === Number(attemptFilter.value))));
</script>

<template>
  <div>
    <div class="flex gap-2 mb-2">
      <label>任务 <select v-model="taskFilter" aria-label="按任务筛选日志"><option value="">全部</option><option v-for="task in tasks" :key="task" :value="task">{{ task }}</option></select></label>
      <label>尝试 <input v-model="attemptFilter" type="number" min="1" aria-label="按尝试筛选日志" class="w-20 border rounded" /></label>
    </div>
    <div class="flex items-center justify-between mb-2">
      <h3 class="text-base font-semibold text-gray-700">{{ $t('agentLog.title') }}</h3>
      <div class="flex items-center space-x-2">
        <label class="flex items-center space-x-1 text-xs text-gray-500 cursor-pointer">
          <input type="checkbox" v-model="autoScroll" class="rounded">
          <span>{{ $t('agentLog.autoScroll') }}</span>
        </label>
        <label class="flex items-center space-x-1 text-xs text-gray-500 cursor-pointer">
          <input type="checkbox" v-model="debugMode" class="rounded">
          <span>Debug</span>
        </label>
        <button
          class="px-2 py-0.5 text-xs bg-gray-200 text-gray-600 rounded hover:bg-gray-300"
          @click="emit('clear')"
        >{{ $t('agentLog.clear') }}</button>
      </div>
    </div>

    <div
      v-if="logs.length === 0"
      class="border border-gray-200 rounded-lg p-6 text-center text-gray-400 text-sm"
    >
      <template v-if="lifecycle && isTerminalState(lifecycle)">
        <svg class="h-5 w-5 mx-auto mb-2 text-gray-300" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-3-3v6m-7 4h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
        <div>{{ $t('agentLog.ended') }}</div>
        <div class="text-xs mt-1">
          {{ $t('agentLog.finalState') }} <span :class="lifecycle.kind === 'completed' ? 'text-green-500' : 'text-red-500'">{{ stateLabel(lifecycle) }}</span>
        </div>
      </template>
      <template v-else>
        <svg class="animate-spin h-5 w-5 mx-auto mb-2 text-blue-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <div>{{ $t('agentLog.waiting') }}</div>
        <div v-if="lifecycle" class="text-xs mt-1">{{ $t('agentLog.currentState') }} {{ stateLabel(lifecycle) }}</div>
      </template>
    </div>

    <div
      v-else
      :ref="el => { agentLogContainer = el as HTMLElement | null; }"
      class="agent-log border border-gray-200 rounded-lg overflow-y-auto bg-white"
      style="max-height: 20rem;"
    >
      <div
        v-for="(log, idx) in filteredLogs"
        :key="idx"
        class="agent-log-item"
        :class="'log-' + log.type"
      >
        <span class="log-badge">{{ agentLogLabel(log.type) }}</span>
        <span class="text-gray-400 text-xs pr-1">{{ formatLogTime(log.timestamp) }}</span>
        <span v-if="log.phase" class="text-gray-400 text-xs pr-1">[{{ log.phase }}]</span>
        <span v-if="log.identity" class="text-xs text-blue-600">{{ log.identity.taskId }} · 第 {{ log.identity.attemptNo }} 次 </span>
        <span class="text-gray-700 break-all">{{ log.summary }}</span>
      </div>
    </div>
    <div v-if="logs.length > 0" class="text-xs text-gray-400 mt-1 text-right">{{ $t('agentLog.count', { count: logs.length }) }}</div>
  </div>
</template>
