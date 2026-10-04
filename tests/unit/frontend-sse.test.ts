// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { useSSE } from '../../src/web/frontend/src/composables/useSSE';
import { invalidateWorkbench } from '../../src/web/frontend/src/api/queryClient';

vi.mock('../../src/web/frontend/src/api/queryClient', () => ({ invalidateWorkbench: vi.fn() }));

class FakeEventSource {
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onerror?: () => void;
  close = vi.fn();
  listeners = new Map<string, (event: { data: string }) => void>();
  constructor(_url: string) { FakeEventSource.instances.push(this); }
  addEventListener(name: string, listener: (event: { data: string }) => void) {
    this.listeners.set(name, listener);
  }
  emit(name: string, payload = {}) { this.listeners.get(name)?.({ data: JSON.stringify(payload) }); }
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); FakeEventSource.instances = []; });

it('多个组件共用连接，错误时交给原生重连，恢复后刷新缓存，最后退出才关闭', () => {
  vi.stubGlobal('EventSource', FakeEventSource);
  const handler = vi.fn();
  const component = defineComponent({ setup() { const { connected } = useSSE(handler); return () => h('span', String(connected.value)); } });
  const first = mount(component);
  const second = mount(component);
  try {
    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0];
    source.emit('connected');
    expect(invalidateWorkbench).toHaveBeenCalledOnce();
    source.onerror?.();
    expect(source.close).not.toHaveBeenCalled();
    source.emit('connected');
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(invalidateWorkbench).toHaveBeenCalledTimes(2);
    source.emit('issue:updated', { data: { issueIid: 42 } });
    expect(invalidateWorkbench).toHaveBeenLastCalledWith(42);
    source.emit('agent:output', { data: { issueIid: 42 } });
    expect(invalidateWorkbench).toHaveBeenCalledTimes(3);
    first.unmount();
    expect(source.close).not.toHaveBeenCalled();
    second.unmount();
    expect(source.close).toHaveBeenCalledOnce();
  } finally { first.unmount(); second.unmount(); }
});
