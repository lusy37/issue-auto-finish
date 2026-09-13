import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { reviewApi } from '../helpers/review-api.js';
import { newTracker } from '../helpers/dag-repository.js';
let f: Awaited<ReturnType<typeof reviewApi>>;
beforeEach(async () => { f = await reviewApi(); });
afterEach(async () => { await f.close(); });

describe('工作目录不存在时审核仍完整可用', () => {
  it('未创建 worktree 可以驳回', async () => { expect(fs.existsSync(f.config.project.worktreeBaseDir)).toBe(false); expect((await f.decide()).status).toBe(200); });
  it('反馈直接保存在聚合文件，不依赖后备目录', async () => { await f.decide(); expect(fs.existsSync(path.join(f.data, 'review-backups'))).toBe(false); expect(newTracker(f.data).get(42)!.run!.reviewHistory).toHaveLength(1); });
  it('HTTP 能读取计划完整快照', async () => { const response = await f.request('GET', '/api/issues/42/plans/01-plan.md'); expect(response.status).toBe(200); expect(response.body).toContain('错误处理'); });
  it('重启后仍能读取反馈', async () => { await f.decide(); expect(newTracker(f.data).get(42)!.run!.reviewHistory![0].feedback).toBe('补充错误处理'); });
  it('缺少引用版本时启动明确报错并保留运行文件', () => { fs.unlinkSync(f.tracker.store.planFile(42, 1)); expect(() => newTracker(f.data)).toThrow('计划版本'); expect(fs.existsSync(f.tracker.store.file(42))).toBe(true); });
});
