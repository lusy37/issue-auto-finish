import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { reviewApi } from '../helpers/review-api.js';
let f: Awaited<ReturnType<typeof reviewApi>>;
beforeEach(async () => { f = await reviewApi(); });
afterEach(async () => { await f.close(); });

describe('驳回经过真实状态转换和持久化', () => {
  it('直接入口与 HTTP 共享同一审核事务', async () => { await f.orchestrator.applyGateAction(42, { action: 'reject', feedback: '需要边界测试' }, 1); expect(f.tracker.get(42)!.run!.reviewHistory![0].feedback).toBe('需要边界测试'); expect(f.github.createIssueNote).toHaveBeenCalledTimes(1); });
  it('缺少版本的内部调用不能绕过校验', async () => { await expect(f.orchestrator.applyGateAction(42, { action: 'approve' })).rejects.toThrow('过期'); expect(f.tracker.get(42)!.run!.review!.decision).toBe('waiting'); });
});
