import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { reviewApi } from '../helpers/review-api.js';
let f: Awaited<ReturnType<typeof reviewApi>>;
beforeEach(async () => { f = await reviewApi(); });
afterEach(async () => { await f.close(); });

describe('不可变计划版本差异', () => {
  it('新版与驳回快照的差异可以在没有 worktree 时查看', async () => { await f.decide(); f.newPlan('第二版新增幂等处理'); const response = await f.request('GET', '/api/issues/42/plan-diff'); expect(response.status).toBe(200); expect(response.body.hasChanges).toBe(true); expect(response.body.diff).toContain('第二版新增幂等处理'); expect(response.body.diff).toContain('round-1'); });
  it('相同内容返回空差异', async () => { await f.decide(); f.newPlan(); expect((await f.request('GET', '/api/issues/42/plan-diff')).body).toEqual({ diff: '', hasChanges: false }); });
  it('首版尚未驳回时没有差异基线', async () => { expect((await f.request('GET', '/api/issues/42/plan-diff')).body.hasChanges).toBe(false); });
  it('路径穿越请求被拒绝', async () => { expect((await f.request('GET', '/api/issues/42/plan-diff?file=../../run.json')).status).toBe(400); });
  it('计划生成后即只读，拒绝写展示副本', async () => { const before = f.tracker.get(42); expect((await f.request('PUT', '/api/issues/42/plans/01-plan.md', { content: '伪造计划' })).status).toBe(403); expect(f.tracker.get(42)).toEqual(before); });
});
