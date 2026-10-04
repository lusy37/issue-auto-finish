import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { newTracker, task } from '../helpers/dag-repository.js';
import { UatPhase } from '../../src/phases/UatPhase.js';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import { ARTIFACTS } from '../../src/shared/runtime/artifacts.js';
import { executeUat } from '../../src/e2e/PlaywrightRunner.js';
import { createTestConfig, createMockAIRunner } from '../helpers/mock-factories.js';
vi.mock('../../src/e2e/PlaywrightRunner.js', () => ({ executeUat: vi.fn() }));
describe('UAT 修复入口分类', () => {
  it.each(['assertion', 'environment'] as const)('%s 失败只允许确定的断言问题进入业务修复', async failureKind => {
    const config = createTestConfig(); config.verifyFixLoop.enabled = true;
    const workDir = process.env.DATA_DIR!;
    fs.writeFileSync(path.join(workDir, config.e2e.configFile), 'export default {};');
    vi.mocked(executeUat).mockImplementation(async ({ runId, issueIid }) => ({
      runId: runId!, issueIid: issueIid, passed: false, playwrightExitCode: 1, machineCancelled: false, reportValid: true, reportErrors: [],
      passedTests: 0, failedTests: failureKind === 'assertion' ? 1 : 0, skippedTests: 0, screenshots: [],
      failureKind, error: failureKind === 'assertion' ? 'expect 页面标题通过' : '浏览器启动失败',
      startedAt: new Date().toISOString(), machineFinishedAt: new Date().toISOString(), reportAvailable: true,
    }));
    const plan = new PlanPersistence(workDir, 1, workDir);
    const tracker = newTracker(workDir);
    tracker.create({
      lifecycle: { kind: 'running', phase: 'uat' },
      branchName: 'iaf-1',
      demandSpec: {
        demandId: 'gh-1', title: '需求', description: '实现', createdAt: new Date().toISOString(),
        sourceRef: { source: 'github-issue', externalId: '1', displayId: '1' },
      },
    });
    tracker.store.savePlan(1, {
      title: '需求', description: '实现', acceptanceCriteria: ['通过'], tasks: [task('a')],
    }, tracker.get(1)!.run!.version);
    tracker.transaction(1, (record) => {
      record.run!.candidateCommit = 'candidate';
      record.run!.dispatchId = 'dispatch';
      record.run!.phaseExecutions.uat = 1;
    });
    const phase = new UatPhase(createMockAIRunner(), plan, config, tracker);
    const result = await phase.run({ workDir, branchName: 'iaf-1', demand: { demandId: 'gh-1', title: '需求', description: '实现', createdAt: new Date().toISOString(), sourceRef: { source: 'github-issue', externalId: '1', displayId: '1' } } });
    expect(result).toMatchObject(failureKind === 'assertion' ? { kind: 'requestRetryFrom', targetPhaseId: 'build' } : { kind: 'failed', error: { retryable: 'hard-no-auto' } });
    const summary = JSON.parse(plan.readFile(ARTIFACTS.uatRun.filename)!);
    expect(summary).toMatchObject({ format: 'iaf-mini/uat/v1', passed: false });
    expect(summary.runId).toEqual(expect.any(String));
    expect(plan.readFile(ARTIFACTS.uatReport.filename)).toContain(`运行：${summary.runId}`);
    expect(phase.getResultFiles()).toEqual([{ filename: '03-uat-report.md', label: '浏览器验收报告' }]);
  });
});
