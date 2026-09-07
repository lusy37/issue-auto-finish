<script setup lang="ts">
import type { AgentLogEntry, IssueState } from '@/types';
import { usePipeline } from '@/composables/usePipeline';
import { useAgentLogs } from '@/composables/useAgentLogs';
import { formatLogTime } from '@/utils/formatters';

const props = defineProps<{
  logs: AgentLogEntry[];
  issueState?: IssueState;
  currentPhase?: string;
}>();

const emit = defineEmits<{
  clear: [];
}>();

const autoScroll = defineModel<boolean>('autoScroll', { default: true });
const debugMode = defineModel<boolean>('debugMode', { default: false });

const { stateLabel, isTerminalState } = usePipeline();
const { agentLogContainer, agentLogLabel } = useAgentLogs();
</script>

<template>
  <div>
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
      <template v-if="issueState && isTerminalState(issueState)">
        <svg class="h-5 w-5 mx-auto mb-2 text-gray-300" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-3-3v6m-7 4h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
        <div>{{ $t('agentLog.ended') }}</div>
        <div class="text-xs mt-1">
          {{ $t('agentLog.finalState') }} <span :class="issueState === 'completed' ? 'text-green-500' : 'text-red-500'">{{ stateLabel(issueState, currentPhase) }}</span>
        </div>
      </template>
      <template v-else>
        <svg class="animate-spin h-5 w-5 mx-auto mb-2 text-blue-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <div>{{ $t('agentLog.waiting') }}</div>
        <div v-if="issueState" class="text-xs mt-1">{{ $t('agentLog.currentState') }} {{ stateLabel(issueState, currentPhase) }}</div>
      </template>
    </div>

    <div
      v-else
      :ref="el => { agentLogContainer = el as HTMLElement | null; }"
      class="agent-log border border-gray-200 rounded-lg overflow-y-auto bg-white"
      style="max-height: 20rem;"
    >
      <div
        v-for="(log, idx) in logs"
        :key="idx"
        class="agent-log-item"
        :class="'log-' + log.type"
      >
        <span class="log-badge">{{ agentLogLabel(log.type) }}</span>
        <span class="text-gray-400 text-xs pr-1">{{ formatLogTime(log.timestamp) }}</span>
        <span v-if="log.phase" class="text-gray-400 text-xs pr-1">[{{ log.phase }}]</span>
        <span class="text-gray-700 break-all">{{ log.summary }}</span>
      </div>
    </div>
    <div v-if="logs.length > 0" class="text-xs text-gray-400 mt-1 text-right">{{ $t('agentLog.count', { count: logs.length }) }}</div>
  </div>
</template>
