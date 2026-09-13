import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { reviewApi } from '../helpers/review-api.js';
import { IssueState } from '../../src/tracker/IssueState.js';
let f: Awaited<ReturnType<typeof reviewApi>>;
beforeEach(async () => { f = await reviewApi(); });
afterEach(async () => { await f.close(); });

describe('所有审核入口的状态与版本隔离', () => {
  it.each(['approve-plan', 'skip-review', 'reject-plan'])('%s 接受当前版本并且仅决定一次', async action => { expect((await f.decide(action)).status).toBe(200); expect((await f.decide(action)).status).not.toBe(200); });
  it.each(['approve-plan', 'skip-review', 'reject-plan'])('%s 拒绝缺失及过期版本', async action => { expect((await f.request('POST', '/api/issues/42/' + action, { feedback: '反馈' })).status).toBe(409); f.newPlan(); expect((await f.decide(action, { planRevision: 1 })).status).toBe(409); });
  it('审核请求不能改变构建阶段', async () => { f.tracker.updateState(42, IssueState.PhaseRunning, { currentPhase: 'build' }); expect((await f.decide('approve-plan')).status).toBe(400); expect(f.tracker.get(42)!.currentPhase).toBe('build'); });
  it('其他等待阶段不能被 review 接口批准', async () => { f.tracker.updateState(42, IssueState.PhaseWaiting, { currentPhase: 'uat' }); expect((await f.decide('approve-plan')).status).toBe(400); });
  it('同时批准和驳回只有一个成功，历史只增加一次', async () => { const result = await Promise.all([f.decide('approve-plan'), f.decide('reject-plan')]); expect(result.filter(r => r.status === 200)).toHaveLength(1); expect(f.tracker.get(42)!.phaseHistory).toHaveLength(1); });
});
