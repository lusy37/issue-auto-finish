// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import NativeInterventionPanel from '../../src/web/frontend/src/components/NativeInterventionPanel.vue';
import type { IssueRecord } from '../../src/web/frontend/src/types/index.js';
import { newIssueRun } from '../../src/dag/contracts.js';
import * as api from '../../src/web/frontend/src/api/client.js';

vi.mock('../../src/web/frontend/src/api/client.js', () => ({
  retryIssue: vi.fn(), continueIssue: vi.fn(), restartIssue: vi.fn(),
  fetchSupplement: vi.fn(), saveSupplement: vi.fn(),
}));
// 组件测试只验证交互契约，真实 Naive UI 渲染由浏览器回归覆盖。
vi.mock('naive-ui/es/alert', () => ({ NAlert: { props: ['title'], template: '<div><strong>{{ title }}</strong><slot /></div>' } }));
vi.mock('naive-ui/es/card', () => ({ NCard: { template: '<section><slot /></section>' } }));
vi.mock('naive-ui/es/button', () => ({ NButton: { template: '<button><slot /></button>' } }));
vi.mock('naive-ui/es/input', () => ({ NInput: { props: ['value'], emits: ['update:value'], template: '<textarea :value="value" @input="$emit(\'update:value\', $event.target.value)" />' } }));

function issue(lifecycle: IssueRecord['lifecycle']): IssueRecord {
  const run = newIssueRun();
  run.retryUsed.build = 3;
  run.repairRounds = 3;
  return {
    lifecycle, run, phaseHistory: [], branchName: 'iaf-42', createdAt: '', updatedAt: '',
    demandSpec: { demandId: '42', sourceRef: { source: 'github-issue', externalId: '42', displayId: '42' }, title: '需求', description: '测试人工介入', createdAt: '' },
  };
}
const failure = { kind: 'failed', phase: 'build', retry: 'manual', error: { message: '集成修复额度已用完', retryable: 'hard-no-auto' } } as const;
const wrappers: ReturnType<typeof mount>[] = [];
function render(lifecycle: IssueRecord['lifecycle'] = failure) {
  const wrapper = mount(NativeInterventionPanel, { props: { issue: issue(lifecycle), maxRetries: 3 } });
  wrappers.push(wrapper);
  return wrapper;
}
function button(wrapper: ReturnType<typeof render>, text: string) {
  return wrapper.findAll('button').find(item => item.text() === text)!;
}
beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.mocked(api.fetchSupplement).mockResolvedValue({ requirements: '原需求', acceptanceCriteria: '', scope: '', constraints: '原约束', references: '', freeText: '已有说明' });
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.restoreAllMocks(); vi.resetAllMocks(); });

describe('失败与暂停的人工介入入口', () => {
  it('次数耗尽仍可手动重试，恢复后通知详情刷新', async () => {
    const wrapper = render();
    expect(wrapper.text()).toContain('自动重试次数已达上限');
    expect(wrapper.text()).toContain('集成修复额度已用完');
    expect(wrapper.text()).toContain('已用集成修复 3 轮');
    await button(wrapper, '手动重试当前阶段').trigger('click');
    await flushPromises();
    expect(api.retryIssue).toHaveBeenCalledWith(42);
    expect(wrapper.emitted('refresh')).toHaveLength(1);
    expect(api.restartIssue).not.toHaveBeenCalled();
  });

  it('暂停可以继续，运行和审核时不显示失败处理区', async () => {
    const wrapper = render({ kind: 'paused', phase: 'uat' });
    await button(wrapper, '继续执行').trigger('click');
    await flushPromises();
    expect(api.continueIssue).toHaveBeenCalledWith(42);
    await wrapper.setProps({ issue: issue({ kind: 'running', phase: 'verify' }) });
    expect(wrapper.find('.native-intervention-panel').exists()).toBe(false);
    await wrapper.setProps({ issue: issue({ kind: 'waiting', phase: 'review' }) });
    expect(wrapper.find('.native-intervention-panel').exists()).toBe(false);
  });

  it('保存处理说明保留原需求字段，保存成功后才完整重做', async () => {
    const wrapper = render();
    await wrapper.get('textarea').setValue('请先修复测试环境');
    await button(wrapper, '保存说明并重新规划').trigger('click');
    await flushPromises();
    expect(api.saveSupplement).toHaveBeenCalledWith(42, expect.objectContaining({ requirements: '原需求', constraints: '原约束', freeText: '已有说明\n\n人工介入说明：\n请先修复测试环境' }));
    expect(api.restartIssue).toHaveBeenCalledWith(42);
    expect(vi.mocked(api.saveSupplement).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.restartIssue).mock.invocationCallOrder[0]);
  });

  it('保存失败保留输入并就地显示错误，不启动重做', async () => {
    vi.mocked(api.saveSupplement).mockRejectedValueOnce(new Error('保存失败'));
    const wrapper = render();
    await wrapper.get('textarea').setValue('保留这条处理说明');
    await button(wrapper, '保存说明并重新规划').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('保存失败');
    expect(wrapper.get('textarea').element.value).toBe('保留这条处理说明');
    expect(api.restartIssue).not.toHaveBeenCalled();
  });

  it('首次补充资料时服务端返回空值，仍可保存说明并重做', async () => {
    vi.mocked(api.fetchSupplement).mockImplementationOnce(async () => JSON.parse('null'));
    const wrapper = render();
    await wrapper.get('textarea').setValue('首次人工说明');
    await button(wrapper, '保存说明并重新规划').trigger('click');
    await flushPromises();
    expect(api.saveSupplement).toHaveBeenCalledWith(42, expect.objectContaining({ requirements: '', freeText: '人工介入说明：\n首次人工说明' }));
    expect(api.restartIssue).toHaveBeenCalledWith(42);
  });

  it('重做失败后再次提交不重复追加说明', async () => {
    vi.mocked(api.restartIssue).mockRejectedValueOnce(new Error('旧执行尚未退出'));
    const wrapper = render();
    await wrapper.get('textarea').setValue('修复环境');
    await button(wrapper, '保存说明并重新规划').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('处理说明已保存，恢复执行失败');
    const saved = vi.mocked(api.saveSupplement).mock.calls[0][1];
    vi.mocked(api.fetchSupplement).mockResolvedValueOnce(saved);
    await button(wrapper, '保存说明并重新规划').trigger('click');
    await flushPromises();
    expect(vi.mocked(api.saveSupplement).mock.calls[1][1]).toEqual(saved);
    expect(wrapper.emitted('refresh')).toHaveLength(1);
  });

  it('取消完整重做不保存说明也不改变执行状态', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const wrapper = render();
    await wrapper.get('textarea').setValue('调整计划');
    await button(wrapper, '保存说明并重新规划').trigger('click');
    expect(api.fetchSupplement).not.toHaveBeenCalled();
    expect(api.restartIssue).not.toHaveBeenCalled();
  });
});
