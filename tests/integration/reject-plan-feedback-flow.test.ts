import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { reviewApi } from '../helpers/review-api.js';
import { newTracker } from '../helpers/dag-repository.js';
import { renderPlan } from '../../src/dag/contracts.js';
let f: Awaited<ReturnType<typeof reviewApi>>;
beforeEach(async () => { f = await reviewApi(); });
afterEach(async () => { await f.close(); });

describe('驳回反馈与不可变计划同事务保存', () => {
  it('保存版本、反馈、完整快照、历史与父状态', async () => {
    const snapshot = renderPlan(f.tracker.store.readPlan(42, 1));
    expect((await f.decide()).status).toBe(200);
    const record = newTracker(f.data).get(42)!;
    expect(record.lifecycle).toEqual({ kind: 'pending' });
    expect(record.run!.review).toMatchObject({ revision: 1, decision: 'rejected', feedback: '补充错误处理' });
    expect(record.run!.reviewHistory![0]).toMatchObject({ revision: 1, planSnapshot: snapshot });
    expect(record.phaseHistory?.at(-1)?.outcome).toBe('gate-rejected');
  });
  it('展示反馈由聚合状态生成', async () => { await f.decide(); expect(f.persistence.readReviewFeedback()).toContain('补充错误处理'); });
  it('重新规划保留上一版反馈与计划快照', async () => { await f.decide(); await f.newPlan('第二版'); expect(f.persistence.readReviewHistory()[0].planSnapshot).toContain('边界测试'); });
  it('多轮驳回按顺序保留且不重复', async () => { await f.decide(); await f.newPlan(); await f.decide('reject-plan', { feedback: '补充重试' }); expect(f.persistence.readReviewHistory().map(x => x.feedback)).toEqual(['补充错误处理', '补充重试']); });
  it('旧页面的驳回不能作用于新版本', async () => { await f.newPlan(); const before = f.tracker.get(42); expect((await f.decide('reject-plan', { planRevision: 1 })).status).toBe(409); expect(f.tracker.get(42)).toEqual(before); });
  it('空反馈不写审核决定', async () => { expect((await f.decide('reject-plan', { feedback: '' })).status).toBe(400); expect(f.tracker.get(42)!.run!.review!.decision).toBe('waiting'); });
  it('平台评论失败不丢失已经提交的反馈', async () => { f.github.createIssueNote.mockRejectedValue(new Error('平台离线')); expect((await f.decide()).status).toBe(200); expect(newTracker(f.data).get(42)!.run!.reviewHistory).toHaveLength(1); });
});
