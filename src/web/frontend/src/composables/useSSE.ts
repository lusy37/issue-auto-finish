import { ref, onMounted, onUnmounted } from 'vue';
import { invalidateWorkbench } from '../api/queryClient.js';

export type SSEHandler = (eventName: string, data: unknown) => void;

const SSE_EVENTS = [
  'issue:updated', 'issue:created', 'issue:failed',
  'issue:deleted', 'issue:resetForRetry', 'issue:restarted',
  'issue:retryFromPhase', 'issue:paused', 'issue:continued',
  'uat:completed', 'uat:failed',
  'gate:approved', 'gate:rejected', 'agent:output', 'pipeline:progress',
] as const;

const connected = ref(false);
const handlers = new Set<SSEHandler>();
let eventSource: EventSource | null = null;

function dispatch(eventName: string, data: unknown) {
  for (const h of handlers) {
    try { h(eventName, data); } catch { /* ignore */ }
  }
}

function connect() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource('/api/events');

  eventSource.addEventListener('connected', () => {
    connected.value = true;
    invalidateWorkbench();
    dispatch('connected', {});
  });
  eventSource.addEventListener('heartbeat', () => { connected.value = true; });

  for (const name of SSE_EVENTS) {
    eventSource.addEventListener(name, (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data);
        if (name !== 'agent:output') {
          const number = payload?.data?.issueIid;
          invalidateWorkbench(typeof number === 'number' ? number : undefined);
        }
        dispatch(name, payload);
      } catch { /* ignore */ }
    });
  }

  eventSource.onerror = () => {
    connected.value = false;
  };
}

function ensureConnection() {
  if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
    connect();
  }
}

function teardownIfIdle() {
  if (handlers.size > 0) return;
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  connected.value = false;
}

/** 多组件共享原生 EventSource，最后一个订阅者退出后关闭连接。 */
export function useSSE(handler: SSEHandler) {
  const subscriber: SSEHandler = (name, data) => handler(name, data);
  onMounted(() => {
    handlers.add(subscriber);
    ensureConnection();
  });

  onUnmounted(() => {
    handlers.delete(subscriber);
    teardownIfIdle();
  });

  return { connected };
}
