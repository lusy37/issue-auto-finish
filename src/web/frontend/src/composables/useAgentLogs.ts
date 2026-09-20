import { summarizeAgentEvent, clampAgentSummary } from '../../../../shared/runtime/agentLogs.js';
export { summarizeAgentEvent } from '../../../../shared/runtime/agentLogs.js';
import { ref, computed, nextTick, type Ref } from 'vue';
import type { AgentLogEntry } from '@/types';
import { t } from '@/i18n/index';

const AGENT_LOG_MAX = 500;

const NORMAL_DISPLAY_TYPES = new Set(['assistant', 'system', 'thinking', 'raw', 'error']);


export function useAgentLogs() {
  const agentLogs = ref<AgentLogEntry[]>([]);
  const agentAutoScroll = ref(true);
  const debugMode = ref(false);
  const agentLogContainer = ref<HTMLElement | null>(null);

  const filteredLogs = computed(() => {
    const logs = debugMode.value
      ? agentLogs.value
      : agentLogs.value.filter(log => NORMAL_DISPLAY_TYPES.has(log.type));
    return logs.filter(log => log.summary.trim().length > 0);
  });

  function agentLogLabel(type: string): string {
    return t(`agentLog.type.${type}`) || type;
  }

  function scrollToTop() {
    if (agentAutoScroll.value) {
      nextTick(() => {
        const el = agentLogContainer.value;
        if (el) el.scrollTop = 0;
      });
    }
  }

  function pushLog(entry: AgentLogEntry) {
    agentLogs.value.unshift({ ...entry, summary: clampAgentSummary(entry.summary) });
    if (agentLogs.value.length > AGENT_LOG_MAX) {
      agentLogs.value = agentLogs.value.slice(0, AGENT_LOG_MAX);
    }
    scrollToTop();
  }

  function pushAgentStreamEvent(
    issueIid: number,
    selectedIid: Ref<number | undefined>,
    phase: string | undefined,
    streamEvent: { identity?: AgentLogEntry['identity']; type?: string; content?: unknown; timestamp?: string },
  ) {
    if (selectedIid.value !== issueIid) return;
    pushLog({
      type: streamEvent.type ?? 'raw',
      identity: streamEvent.identity,
      phase,
      timestamp: streamEvent.timestamp ?? new Date().toISOString(),
      summary: summarizeAgentEvent(streamEvent),
    });
  }

  function pushSystemLog(
    issueIid: number,
    selectedIid: Ref<number | undefined>,
    step: string | undefined,
    message: string,
    timestamp: string,
  ) {
    if (selectedIid.value !== issueIid) return;
    pushLog({ type: 'system', phase: step, timestamp, summary: message });
  }

  function clear() {
    agentLogs.value = [];
  }

  return {
    agentLogs,
    filteredLogs,
    agentAutoScroll,
    debugMode,
    agentLogContainer,
    agentLogLabel,
    pushLog,
    pushAgentStreamEvent,
    pushSystemLog,
    scrollToTop,
    clear,
  };
}
