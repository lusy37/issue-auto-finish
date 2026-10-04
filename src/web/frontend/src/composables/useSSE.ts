import { ref, onMounted, onUnmounted } from 'vue';

export type SSEHandler = (eventName: string, data: unknown) => void;

const SSE_EVENTS = [
  'issue:updated', 'issue:created', 'issue:failed',
  'issue:deleted', 'issue:resetForRetry', 'issue:restarted',
  'issue:retryFromPhase', 'issue:paused', 'issue:continued',
  'gate:approved', 'gate:rejected', 'agent:output', 'pipeline:progress',
] as const;

const connected = ref(false);
const handlers = new Set<SSEHandler>();
let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;

function dispatch(eventName: string, data: unknown) {
  for (const h of handlers) {
    try { h(eventName, data); } catch { /* ignore */ }
  }
}

function connect() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (eventSource) eventSource.close();

  eventSource = new EventSource('/api/events');

  eventSource.addEventListener('connected', () => {
    connected.value = true;
    reconnectAttempt = 0;
  });
  eventSource.addEventListener('heartbeat', () => { connected.value = true; });

  for (const name of SSE_EVENTS) {
    eventSource.addEventListener(name, (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data);
        dispatch(name, payload);
      } catch { /* ignore */ }
    });
  }

  eventSource.onerror = () => {
    connected.value = false;
    if (handlers.size > 0) {
      reconnectAttempt++;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt - 1, 5));
      reconnectTimer = setTimeout(connect, delay);
    }
  };
}

function ensureConnection() {
  if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
    connect();
  }
}

function teardownIfIdle() {
  if (handlers.size > 0) return;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  reconnectAttempt = 0;
  connected.value = false;
}

/**
 * Shared SSE composable backed by a module-level singleton EventSource.
 * Multiple components can call useSSE() without creating duplicate connections.
 */
export function useSSE(handler: SSEHandler) {
  onMounted(() => {
    handlers.add(handler);
    ensureConnection();
  });

  onUnmounted(() => {
    handlers.delete(handler);
    teardownIfIdle();
  });

  return { connected };
}
