// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, type EffectScope } from 'vue';
import { queryClient } from '../../src/web/frontend/src/api/queryClient';
import { flushPromises } from '@vue/test-utils';
import { useIssueDetail as createIssueDetail } from '../../src/web/frontend/src/composables/useIssueDetail';
import { useAction } from '../../src/web/frontend/src/composables/useAction';
import type { AgentLogEntry, IssueRecord } from '../../src/web/frontend/src/types';
import { newIssueRun } from '../../src/dag/contracts.js';
import * as api from '../../src/web/frontend/src/api/client';

vi.mock('../../src/web/frontend/src/api/client', () => ({
  fetchIssueDetail: vi.fn(), fetchIssueLogs: vi.fn(), fetchSupplement: vi.fn(),
  fetchReviewHistory: vi.fn(), loadPlanDoc: vi.fn(), fetchPlanDiff: vi.fn(),
  abortIssue: vi.fn(), restartIssue: vi.fn(), approvePlan: vi.fn(), rejectPlan: vi.fn(),
  saveSupplement: vi.fn(), retryFromPhase: vi.fn(),
}));

function record(number = 42, version = 1): IssueRecord {
  return {
    lifecycle: { kind: 'waiting', phase: 'review', planRevision: 3 },
    run: { ...newIssueRun(), version, planRevision: 3 }, phaseHistory: [],
    branchName: `iaf-${number}`, createdAt: '', updatedAt: '',
    demandSpec: {
      demandId: String(number), createdAt: '', title: '测试需求', description: '',
      sourceRef: { source: 'github-issue', externalId: String(number), displayId: String(number) },
    },
  };
}

let scope: EffectScope;
const useIssueDetail = () => scope.run(createIssueDetail)!;
beforeEach(() => {
  scope = effectScope();
  vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
  vi.mocked(api.fetchIssueDetail).mockImplementation(async number => record(number));
  vi.mocked(api.fetchIssueLogs).mockResolvedValue([]);
  vi.mocked(api.fetchSupplement).mockResolvedValue(null);
  vi.mocked(api.fetchReviewHistory).mockResolvedValue([]);
  vi.mocked(api.loadPlanDoc).mockResolvedValue('');
  vi.mocked(api.fetchPlanDiff).mockResolvedValue({ diff: '', hasChanges: false });
});
afterEach(() => { scope.stop(); queryClient.clear(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe('详情加载和操作', () => {
  it('首次加载只请求一次详情，无补充资料时使用空表单', async () => {
    const detail = useIssueDetail();
    await detail.selectIssue(42, { value: [] });
    await flushPromises();
    expect(api.fetchIssueDetail).toHaveBeenCalledExactlyOnceWith(42, expect.anything());
    expect(detail.selectedIssue.value?.run.planRevision).toBe(3);
    expect(detail.detailSupplement.value.requirements).toBe('');
    expect(detail.detailLoading.value).toBe(false);
  });

  it('中止成功只刷新一次详情，重启不会再次选择 Issue', async () => {
    const detail = useIssueDetail();
    await detail.selectIssue(42, { value: [] });
    vi.mocked(api.fetchIssueDetail).mockClear();
    vi.mocked(api.fetchIssueLogs).mockClear();
    await detail.doAbortIssue(42, detail.refreshDetail);
    expect(api.fetchIssueDetail).toHaveBeenCalledExactlyOnceWith(42, expect.anything());
    vi.mocked(api.fetchIssueDetail).mockClear();
    await detail.doRestartIssue(42, detail.refreshDetail);
    expect(api.fetchIssueDetail).toHaveBeenCalledExactlyOnceWith(42, expect.anything());
    expect(api.fetchIssueLogs).not.toHaveBeenCalled();
  });

  it('用户取消确认时不调用接口和刷新', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    const refresh = vi.fn();
    await useIssueDetail().doAbortIssue(42, refresh);
    expect(api.abortIssue).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('操作失败交给页面错误状态，失败后不刷新', async () => {
    vi.mocked(api.abortIssue).mockRejectedValueOnce(new Error('执行尚未退出'));
    const detail = useIssueDetail();
    const page = useAction();
    const refresh = vi.fn();
    await page.run(() => detail.doAbortIssue(42, refresh));
    expect(page.error.value).toBe('执行尚未退出');
    expect(page.busy.value).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('审核使用已加载的实际版本，未加载或选择其他 Issue 时拒绝提交', async () => {
    const detail = useIssueDetail();
    const refresh = vi.fn();
    await expect(detail.doApprovePlan(42, refresh)).rejects.toThrow('请先加载');
    await detail.selectIssue(42, { value: [] });
    vi.mocked(api.fetchIssueDetail).mockClear();
    vi.mocked(api.fetchIssueLogs).mockClear();
    await expect(detail.doApprovePlan(43, refresh)).rejects.toThrow('请先加载');
    expect(api.approvePlan).not.toHaveBeenCalled();
    await detail.doApprovePlan(42, refresh);
    expect(api.approvePlan).toHaveBeenCalledExactlyOnceWith(42, 3);
    expect(refresh).toHaveBeenCalledOnce();
    expect(detail.reviewSubmitting.value).toBe(false);
  });

  it('驳回失败保留反馈并释放提交状态', async () => {
    const detail = useIssueDetail();
    await detail.selectIssue(42, { value: [] });
    vi.mocked(api.fetchIssueDetail).mockClear();
    vi.mocked(api.fetchIssueLogs).mockClear();
    detail.reviewFeedback.value = '补充验收标准';
    vi.mocked(api.rejectPlan).mockRejectedValueOnce(new Error('版本已过期'));
    await expect(detail.doRejectPlan(42, vi.fn())).rejects.toThrow('版本已过期');
    expect(detail.reviewFeedback.value).toBe('补充验收标准');
    expect(detail.reviewSubmitting.value).toBe(false);
  });

  it('快速切换 Issue 时，旧详情和日志不能覆盖新选择', async () => {
    let resolveOld!: (value: IssueRecord) => void;
    vi.mocked(api.fetchIssueDetail).mockImplementationOnce(() => (
      new Promise(resolve => { resolveOld = resolve; })
    ));
    const detail = useIssueDetail();
    const logs = { value: [] as AgentLogEntry[] };
    const old = detail.selectIssue(42, logs);
    await detail.selectIssue(43, logs);
    resolveOld(record(42, 100));
    await old;
    expect(detail.selectedIssue.value?.demandSpec.sourceRef.displayId).toBe('43');
    expect(detail.detailLoading.value).toBe(false);
    expect(api.fetchSupplement).toHaveBeenCalledExactlyOnceWith(43, expect.anything());
  });

  it('过期详情版本不能覆盖已显示的新版本', async () => {
    const detail = useIssueDetail();
    vi.mocked(api.fetchIssueDetail).mockResolvedValueOnce(record(42, 10));
    await detail.selectIssue(42, { value: [] });
    vi.mocked(api.fetchIssueDetail).mockResolvedValueOnce(record(42, 9));
    await detail.refreshDetail();
    expect(detail.selectedIssue.value?.run.version).toBe(10);
  });

  it('刷新不会覆盖正在编辑的补充资料草稿', async () => {
    const detail = useIssueDetail();
    await detail.selectIssue(42, { value: [] });
    await flushPromises();
    detail.enterSupplementEdit();
    detail.detailSupplementForm.value.requirements = '尚未保存的草稿';
    await detail.refreshDetail();
    expect(detail.detailSupplementEditing.value).toBe(true);
    expect(detail.detailSupplementForm.value.requirements).toBe('尚未保存的草稿');
  });

  it('保存过程中切换 Issue，迟到响应只更新原 Issue 且不重新规划新 Issue', async () => {
    let resolveSave!: (value: Awaited<ReturnType<typeof api.saveSupplement>>) => void;
    vi.mocked(api.saveSupplement).mockImplementationOnce(() => new Promise(resolve => { resolveSave = resolve; }));
    const detail = useIssueDetail();
    await detail.selectIssue(42, { value: [] });
    const saving = detail.saveDetailSupplement(vi.fn());
    await detail.selectIssue(43, { value: [] });
    resolveSave({ success: true, data: { requirements: '原 Issue 资料' } } as Awaited<ReturnType<typeof api.saveSupplement>>);
    await saving;
    await flushPromises();
    expect(detail.detailSupplement.value.requirements).toBe('');
    expect(queryClient.getQueryData(['issue', 42, 'supplement'])).toMatchObject({ requirements: '原 Issue 资料' });
    expect(api.retryFromPhase).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });
});
