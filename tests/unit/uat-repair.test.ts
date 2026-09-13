import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { UatPhase } from '../../src/phases/UatPhase.js';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import { executeUat } from '../../src/e2e/PlaywrightRunner.js';
import { createTestConfig, createMockAIRunner, createMockGitOperations } from '../helpers/mock-factories.js';
vi.mock('../../src/e2e/PlaywrightRunner.js', () => ({ executeUat: vi.fn() }));
describe('UAT 修复入口分类', () => {
  it.each(['assertion', 'environment'] as const)('%s 失败只允许确定的断言问题进入业务修复', async failureKind => {
    const config = createTestConfig(); config.verifyFixLoop.enabled = true;
    const workDir = process.env.DATA_DIR!;
    fs.writeFileSync(path.join(workDir, config.e2e.configFile), 'export default {};');
    vi.mocked(executeUat).mockResolvedValue({ runId: 'fresh', issueIid: 1, passed: false, failureKind, error: failureKind === 'assertion' ? 'expect 页面标题通过' : '浏览器启动失败', passedTests: 0, failedTests: failureKind === 'assertion' ? 1 : 0, skippedTests: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
    const phase = new UatPhase(createMockAIRunner(), createMockGitOperations(), new PlanPersistence(workDir, 1, workDir), config);
    const result = await phase.run({ workDir, branchName: 'iaf-1', demand: { demandId: 'gh-1', title: '需求', description: '实现', createdAt: new Date().toISOString(), sourceRef: { source: 'github-issue', externalId: '1', displayId: '1' } } });
    expect(result).toMatchObject(failureKind === 'assertion' ? { kind: 'requestRetryFrom', targetPhaseId: 'build' } : { kind: 'failed', error: { retryable: 'hard-no-auto' } });
  });
});
