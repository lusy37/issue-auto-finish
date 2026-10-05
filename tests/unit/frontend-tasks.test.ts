// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';
import { flushPromises, shallowMount } from '@vue/test-utils';
import NativeTaskTable from '../../src/web/frontend/src/components/NativeTaskTable.vue';
import { useTasks } from '../../src/web/frontend/src/composables/useTasks';
import { queryClient, invalidateWorkbench } from '../../src/web/frontend/src/api/queryClient';
import type { ExecutableTask } from '../../src/shared/workbench.js';

// 只验证任务表交互，组件库渲染由浏览器回归覆盖。
vi.mock('naive-ui/es/button', () => ({ NButton: { name: 'NButton', template: '<button><slot /></button>' } }));
vi.mock('naive-ui/es/data-table', () => ({ NDataTable: { name: 'NDataTable', props: ['data', 'pagination', 'columns'], emits: ['update:page'], template: '<div />' } }));
vi.mock('naive-ui/es/empty', () => ({ NEmpty: { name: 'NEmpty', template: '<div><slot /></div>' } }));
vi.mock('naive-ui/es/input', () => ({ NInput: { name: 'NInput', props: ['value'], emits: ['update:value'], template: '<input />' } }));
vi.mock('naive-ui/es/tabs', () => ({
  NTabs: { name: 'NTabs', props: ['value'], emits: ['update:value'], template: '<div><slot /></div>' },
  NTab: { name: 'NTab', props: ['name'], template: '<div><slot /></div>' },
}));
vi.mock('naive-ui/es/tag', () => ({ NTag: { name: 'NTag', template: '<span><slot /></span>' } }));

const task = (taskId: string, lifecycle: ExecutableTask['lifecycle'], stateCategory?: string): ExecutableTask => ({
  kind: 'issue', taskId, title: `需求 ${taskId}`, branchName: `feature/${taskId}`,
  status: 'idle', attempts: 0, createdAt: '', updatedAt: '', lifecycle, stateCategory,
});
const tasks = [
  task('1', { kind: 'waiting', phase: 'review', planRevision: 1 }, 'blocked'),
  task('2', { kind: 'paused', phase: 'build' }, 'blocked'),
  task('3', { kind: 'completed' }),
  task('4', { kind: 'running', phase: 'build' }, 'active'),
];

afterEach(() => { queryClient.clear(); vi.unstubAllGlobals(); });

it('任务查询共用缓存，请求保留取消信号，SSE 失效后重新读取', async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(tasks), {
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetch);
  const scope = effectScope();
  try {
    const first = scope.run(useTasks)!;
    const second = scope.run(useTasks)!;
    await flushPromises();
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/tasks', { signal: expect.any(AbortSignal) });
    expect(queryClient.getQueryData(['tasks'])).toEqual(tasks);
    expect(first.tasks.value).toEqual(second.tasks.value);
    invalidateWorkbench();
    await flushPromises();
    expect(fetch).toHaveBeenCalledTimes(2);
    await first.refresh();
    expect(fetch).toHaveBeenCalledTimes(3);
  } finally { scope.stop(); }
});

it('页签计数与过滤一致，暂停不算审核，未提供分类时仍按生命周期匹配', async () => {
  const wrapper = shallowMount(NativeTaskTable, { props: { tasks }, global: { renderStubDefaultSlot: true } });
  try {
    const counts = wrapper.findAll('.prototype-filter-count').map(item => item.text());
    expect(counts).toEqual(['4', '1', '1', '0', '1', '0']);
    const tabs = wrapper.findComponent({ name: 'NTabs' });
    const table = wrapper.findComponent({ name: 'NDataTable' });
    tabs.vm.$emit('update:value', 'review');
    await nextTick();
    expect(table.props('data')).toEqual([tasks[0]]);
    tabs.vm.$emit('update:value', 'completed');
    await nextTick();
    expect(table.props('data')).toEqual([tasks[2]]);
  } finally { wrapper.unmount(); }
});

it('搜索忽略两端空格和大小写，变更筛选后重置分页', async () => {
  const wrapper = shallowMount(NativeTaskTable, { props: { tasks } });
  try {
    const table = wrapper.findComponent({ name: 'NDataTable' });
    table.vm.$emit('update:page', 2);
    await nextTick();
    expect(table.props('pagination').page).toBe(2);
    wrapper.findComponent({ name: 'NInput' }).vm.$emit('update:value', '  FEATURE/4  ');
    await nextTick();
    expect(table.props('data')).toEqual([tasks[3]]);
    expect(table.props('pagination').page).toBe(1);
  } finally { wrapper.unmount(); }
});
