// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { useIssueDetail } from '../../src/web/frontend/src/composables/useIssueDetail';
import type { IssueRecord } from '../../src/web/frontend/src/types';
import * as api from '../../src/web/frontend/src/api/client';

vi.mock('../../src/web/frontend/src/api/client', () => ({
  saveSupplement: vi.fn().mockResolvedValue({ data: { requirements: '新增验收要求' } }),
  retryFromPhase: vi.fn().mockResolvedValue({ success: true }),
}));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

it('补充需求后确认重新规划，使用当前 plan 阶段并刷新任务列表', async () => {
  vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
  vi.stubGlobal('alert', vi.fn());
  const detail = useIssueDetail();
  detail.selectedIssue.value = { issueIid: 42, demandSpec: { sourceRef: { displayId: '42' } } } as unknown as IssueRecord;
  detail.detailSupplementForm.value = { ...detail.detailSupplementForm.value, requirements: '新增验收要求' };
  const refresh = vi.fn().mockResolvedValue(undefined);
  await detail.saveDetailSupplement(refresh);
  expect(api.retryFromPhase).toHaveBeenCalledWith(42, 'plan');
  expect(refresh).toHaveBeenCalledOnce();
  expect(detail.detailSupplement.value.requirements).toBe('新增验收要求');
  expect(alert).not.toHaveBeenCalled();
});
