import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { reviewApi } from '../helpers/review-api.js';
let f: Awaited<ReturnType<typeof reviewApi>>;
beforeEach(async () => { f = await reviewApi(); });
afterEach(async () => { await f.close(); });

describe('审核历史与仓库路径解耦', () => {
  it.each(['', 'app/中文 目录'])('项目子目录 %s 不影响审核查询', async subdir => { f.config.project.projectSubDir = subdir; await f.decide(); const response = await f.request('GET', '/api/issues/42/review-history'); expect(response.status).toBe(200); expect(response.body[0].feedback).toBe('补充错误处理'); });
});
