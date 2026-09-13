import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { reviewApi } from '../helpers/review-api.js';
let f: Awaited<ReturnType<typeof reviewApi>>;
beforeEach(async () => { f = await reviewApi(); });
afterEach(async () => { await f.close(); });

describe('聚合审核历史是唯一权威来源', () => {
  it('伪造或残留的展示副本不能覆盖真实审核历史', async () => { await f.decide(); const backup = path.join(f.data, 'review-backups', 'issue-42'); fs.mkdirSync(backup, { recursive: true }); fs.writeFileSync(path.join(backup, 'review-history.json'), JSON.stringify([{ round: 1, feedback: '旧副本', timestamp: new Date().toISOString() }])); const response = await f.request('GET', '/api/issues/42/review-history'); expect(response.body).toHaveLength(1); expect(response.body[0].feedback).toBe('补充错误处理'); });
});
