// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { useIssueDetail } from '../../src/web/frontend/src/composables/useIssueDetail';
import { effectScope, type EffectScope } from 'vue';
import { flushPromises } from '@vue/test-utils';
import { queryClient } from '../../src/web/frontend/src/api/queryClient';
import { newIssueRun } from '../../src/dag/contracts';
import type { IssueRecord } from '../../src/web/frontend/src/types';
import * as api from '../../src/web/frontend/src/api/client';

vi.mock('../../src/web/frontend/src/api/client', () => ({
  fetchIssueDetail: vi.fn(),
  fetchIssueLogs: vi.fn().mockResolvedValue([]),
  fetchSupplement: vi.fn().mockResolvedValue(null),
  fetchReviewHistory: vi.fn().mockResolvedValue([]),
  loadPlanDoc: vi.fn().mockResolvedValue(''),
  fetchPlanDiff: vi.fn().mockResolvedValue({ diff: '', hasChanges: false }),
  saveSupplement: vi.fn().mockResolvedValue({ data: { requirements: '新增验收要求' } }),
  retryFromPhase: vi.fn().mockResolvedValue({ success: true }),
}));
let scope: EffectScope;
afterEach(() => { scope.stop(); queryClient.clear(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it('补充需求后确认重新规划，使用当前 plan 阶段并刷新任务列表', async () => {
  vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
  vi.stubGlobal('alert', vi.fn());
  vi.mocked(api.fetchIssueDetail).mockResolvedValue({ demandSpec: { sourceRef: { displayId: '42' } }, run: newIssueRun() } as IssueRecord);
  scope = effectScope();
  const detail = scope.run(useIssueDetail)!;
  await detail.selectIssue(42, { value: [] });
  await flushPromises();
  detail.detailSupplementForm.value = { ...detail.detailSupplementForm.value, requirements: '新增验收要求' };
  const refresh = vi.fn().mockResolvedValue(undefined);
  await detail.saveDetailSupplement(refresh);
  expect(api.retryFromPhase).toHaveBeenCalledWith(42, 'plan');
  expect(refresh).toHaveBeenCalledOnce();
  await flushPromises();
  expect(detail.detailSupplement.value.requirements).toBe('新增验收要求');
  expect(alert).not.toHaveBeenCalled();
});
