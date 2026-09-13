import { ref, computed, nextTick, type Ref } from 'vue';
import type { AgentLogEntry } from '@/types';
import { t } from '@/i18n/index';

const AGENT_LOG_MAX = 500;

const NORMAL_DISPLAY_TYPES = new Set(['assistant', 'system', 'thinking', 'raw', 'error']);

export interface VerifyFixLoopState {
  active: boolean;
  iteration: number;
  maxIterations: number;
  lastPassed: boolean;
}

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
    agentLogs.value.unshift(entry);
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

  // ── Verify-fix loop state ──

  const verifyFixLoop = ref<Record<number, VerifyFixLoopState>>({});

  function updateVerifyFixLoop(issueIid: number, eventName: string, data: Record<string, unknown>) {
    if (eventName === 'verify:loopStarted') {
      verifyFixLoop.value = {
        ...verifyFixLoop.value,
        [issueIid]: {
          active: true,
          iteration: 0,
          maxIterations: data.maxIterations as number,
          lastPassed: false,
        },
      };
    } else if (eventName === 'verify:iterationComplete') {
      const s = verifyFixLoop.value[issueIid];
      if (s) {
        verifyFixLoop.value = {
          ...verifyFixLoop.value,
          [issueIid]: {
            ...s,
            iteration: data.iteration as number,
            lastPassed: data.passed as boolean,
            active: !(data.passed as boolean),
          },
        };
      }
    } else if (eventName === 'verify:loopExhausted') {
      const s = verifyFixLoop.value[issueIid];
      if (s) {
        verifyFixLoop.value = {
          ...verifyFixLoop.value,
          [issueIid]: { ...s, active: false },
        };
      }
    }
  }

  function getVerifyFixLoop(issueIid: number): VerifyFixLoopState | undefined {
    return verifyFixLoop.value[issueIid];
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
    updateVerifyFixLoop,
    getVerifyFixLoop,
  };
}

export function summarizeAgentEvent(evt: { type?: string; content?: unknown; timestamp?: string }): string {
  const content = evt.content;
  if (!content || typeof content === 'string') return String(content ?? '');

  if (evt.type === 'assistant') {
    const msg = (content as Record<string, unknown>).message ?? content;
    if (typeof msg === 'string') return msg.slice(0, 200);
    const m = msg as Record<string, unknown>;
    if (m.text) return (m.text as string).slice(0, 200);
    if (m.content) {
      const parts = Array.isArray(m.content) ? m.content : [m.content];
      const texts = parts
        .filter((c: Record<string, unknown>) => c.type === 'text')
        .map((c: Record<string, unknown>) => c.text)
        .join(' ');
      if (texts) return texts.slice(0, 200);
    }
    // No meaningful text extracted – treat as protocol metadata, not user-facing
    return '';
  }

  if (evt.type === 'thinking') {
    const c = content as Record<string, unknown>;
    const text = (c.text as string) ?? '';
    return text.slice(0, 200);
  }

  if (evt.type === 'tool_use') {
    const c = content as Record<string, unknown>;
    const tool = c.tool as Record<string, unknown> | undefined;
    const name = tool?.name ?? c.name ?? '?';
    const input = (tool?.input ?? c.input ?? {}) as Record<string, unknown>;
    const detail = input.path ?? input.command ?? input.file_path ?? '';
    return name + (detail ? ': ' + detail : '');
  }

  if (evt.type === 'tool_result') {
    const text = typeof (content as Record<string, unknown>).content === 'string'
      ? (content as Record<string, unknown>).content as string
      : JSON.stringify((content as Record<string, unknown>).content ?? '');
    return text.slice(0, 150);
  }

  if (evt.type === 'result') {
    return ((content as Record<string, unknown>).result as string ?? JSON.stringify(content)).slice(0, 200);
  }

  return JSON.stringify(content).slice(0, 150);
}
