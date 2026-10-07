import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { graphFixture, task } from '../helpers/dag-repository.js';
import { createMockAIRunner, createMockOrchestratorDeps, createTestConfig } from '../helpers/mock-factories.js';
import { DagPhaseRunner } from '../../src/orchestrator/DagPhaseRunner.js';
import { GitOperations } from '../../src/git/GitOperations.js';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import { AsyncMutex } from '../../src/utils/AsyncMutex.js';
import { visualCasesPath } from '../../src/e2e/VisualEvidence.js';
import { getPlanModePhases } from '../../src/orchestration/Phases.js';
import { buildPlanModePipeline } from '../../src/pipeline/PipelineMetadata.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('真实 Git 构建的 UAT 准备门禁（仅模拟 AI）', () => {
  it.each([false, true])('清单实际落盘=%s，只有准备完整才能形成候选提交', async materialized => {
    const f = graphFixture([task('a')], buildPlanModePipeline({ e2eEnabled: true })); roots.push(f.directory);
    const config = createTestConfig(); config.e2e.visualReviewEnabled = true;
    Object.assign(config.project, { gitRootDir: f.repo, workDir: f.integration,
      worktreeBaseDir: f.worktrees, baseBranch: 'main', projectSubDir: '' });
    const runner = createMockAIRunner();
    runner.run.mockImplementation(async options => {
      if (options.purpose === 'uat-prepare') {
        fs.writeFileSync(path.join(options.workDir, config.e2e.configFile), 'export default {};');
        const file = visualCasesPath(f.data, 1);
        expect(options.additionalDirectories).toEqual([path.dirname(file)]);
        if (materialized) fs.writeFileSync(file, JSON.stringify({
          format: 'iaf-mini/visual-cases/v1', planDigest: f.tracker.get(1)!.run.planDigest,
          cases: [{ id: 'desktop', sceneId: 'main', acceptanceRefs: ['plan:0'],
            viewports: [{ width: 1440, height: 900 }], expectedState: '页面可见' }],
        }));
      } else {
        fs.writeFileSync(path.join(options.workDir, 'result.txt'), '实现需求');
      }
      return { success: true, exitCode: 0, output: '已完成' };
    });
    const git = new GitOperations(f.integration);
    const phase = new DagPhaseRunner(createMockOrchestratorDeps({
      config, tracker: f.tracker, aiRunner: runner, mainGitMutex: new AsyncMutex(),
    }), git, new PlanPersistence(f.integration, 1, f.data));
    const result = await phase.run(getPlanModePhases(true).find(spec => spec.id === 'build')!, {
      issueIid: 1, workDir: f.integration, branchName: 'iaf-1', demand: f.tracker.get(1)!.demandSpec,
    });
    if (materialized) {
      expect(result.kind).toBe('completed');
      expect(f.tracker.get(1)!.run.candidateCommit).toBe(await git.head());
      expect(await git.hasChanges()).toBe(false);
    } else {
      expect(result).toMatchObject({ kind: 'failed', error: { retryable: 'hard-no-auto' } });
      expect(f.tracker.get(1)!.run.candidateCommit).toBeUndefined();
      expect(f.tracker.get(1)!.run.repairRounds).toBe(0);
    }
  }, 60000);
});
