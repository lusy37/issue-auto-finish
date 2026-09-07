import { ref, onMounted, onUnmounted } from 'vue';

export type SSEHandler = (eventName: string, data: unknown) => void;

const SSE_EVENTS = [
  'issue:stateChanged', 'issue:created', 'issue:failed',
  'issue:deleted', 'issue:resetForRetry', 'issue:restarted',
  'issue:retryFromPhase',

  'gate:requested', 'gate:approved', 'gate:rejected', 'gate:supplemented',
  'agent:output', 'pipeline:progress',
  'verify:loopStarted', 'verify:iterationComplete', 'verify:loopExhausted',
] as const;

const connected = ref(false);
const handlers = new Set<SSEHandler>();
let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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

  eventSource.addEventListener('connected', () => { connected.value = true; });
  eventSource.addEventListener('heartbeat', () => { connected.value = true; });

  for (const name of SSE_EVENTS) {
    eventSource.addEventListener(name, (e: MessageEvent) => {
      try { dispatch(name, JSON.parse(e.data)); } catch { /* ignore */ }
    });
  }

  eventSource.onerror = () => {
    connected.value = false;
    if (handlers.size > 0) {
      reconnectTimer = setTimeout(connect, 5000);
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
