import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { newTracker, task } from '../helpers/dag-repository.js';
import { UatPhase } from '../../src/phases/UatPhase.js';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import { ARTIFACTS } from '../../src/shared/runtime/artifacts.js';
import { executeUat } from '../../src/e2e/PlaywrightRunner.js';
import { createTestConfig, createMockAIRunner } from '../helpers/mock-factories.js';
import { visualCasesPath } from '../../src/e2e/VisualEvidence.js';
vi.mock('../../src/e2e/PlaywrightRunner.js', () => ({ executeUat: vi.fn() }));
describe('UAT 修复入口分类', () => {
  it.each(['缺少配置', '缺少清单', '过期计划', '格式错误'])(
    '%s 在启动 Playwright 前停止，保存本轮失败且不消耗修复次数', async name => {
      const workDir = path.join(process.env.DATA_DIR!, name);
      fs.mkdirSync(workDir, { recursive: true });
      const config = createTestConfig(); config.e2e.visualReviewEnabled = true;
      const tracker = newTracker(workDir);
      const demand = { demandId: 'gh-1', title: '需求', description: '实现',
        createdAt: new Date().toISOString(),
        sourceRef: { source: 'github-issue' as const, externalId: '1', displayId: '1' } };
      tracker.create({ lifecycle: { kind: 'running', phase: 'uat' }, branchName: 'iaf-1', demandSpec: demand });
      tracker.store.savePlan(1, {
        title: '需求', description: '实现', acceptanceCriteria: ['通过'], tasks: [task('a')],
      }, tracker.get(1)!.run.version);
      tracker.transaction(1, record => {
        record.run.candidateCommit = 'candidate'; record.run.dispatchId = 'dispatch';
        record.run.phaseExecutions.uat = 1; record.run.repairRounds = 2; record.run.uatReviewRounds = 1;
        record.run.uat = { commit: 'old', passed: true, completedAt: new Date().toISOString(),
          reportPath: 'old-report', runId: 'old-run', uatEvidence: {
            format: 'iaf-mini/uat/v1', summaryDigest: 'old-summary',
            execution: { candidateCommit: 'old', planRevision: record.run.planRevision,
              planDigest: record.run.planDigest!, buildGeneration: record.run.buildGeneration,
              dispatchId: 'old-dispatch', phaseAttemptNo: 1 },
            policy: { visualReviewEnabled: true, maxImages: 12, timeoutMs: 1000 },
          } };
      });
      if (name !== '缺少配置') fs.writeFileSync(path.join(workDir, config.e2e.configFile), 'export default {};');
      if (name === '过期计划' || name === '格式错误') {
        const file = visualCasesPath(workDir, 1);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, name === '格式错误' ? '{' : JSON.stringify({
          format: 'iaf-mini/visual-cases/v1', planDigest: 'old-plan',
          cases: [{ id: 'desktop', sceneId: 'main', acceptanceRefs: ['plan:0'],
            viewports: [{ width: 1440, height: 900 }], expectedState: '页面可见' }],
        }));
      }
      vi.mocked(executeUat).mockClear();
      const runner = createMockAIRunner(), persistence = new PlanPersistence(workDir, 1, workDir);
      const result = await new UatPhase(runner, persistence, config, tracker).run({
        workDir, branchName: 'iaf-1', demand,
      });
      expect(result).toMatchObject({ kind: 'failed', error: { retryable: 'hard-no-auto' } });
      expect(executeUat).not.toHaveBeenCalled(); expect(runner.run).not.toHaveBeenCalled();
      expect(tracker.get(1)!.run).toMatchObject({ repairRounds: 2, uatReviewRounds: 1,
        uatExecution: { status: 'completed' } });
      expect(tracker.get(1)!.run.uat).toBeUndefined();
      const summary = JSON.parse(persistence.readFile(ARTIFACTS.uatRun.filename)!);
      expect(summary).toMatchObject({ passed: false, machinePassed: false, reportAvailable: false,
        failureKind: 'environment', visualReview: { reasonCode: 'uat-preparation-invalid' } });
      expect(summary.machineFinishedAt).toBeUndefined();
      expect(persistence.readFile(ARTIFACTS.uatReport.filename)).toContain('未启动 Playwright');
      expect(persistence.readFile(ARTIFACTS.uatReport.filename)).not.toContain('[HTML 报告]');
    },
  );
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
