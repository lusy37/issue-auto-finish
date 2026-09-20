import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import { resolveDataDir } from '../../src/paths.js';
import { newTracker } from './dag-repository.js';
import { structuredPlanOutput } from './structured-plan.js';

/** 用当前聚合事务准备审核事实，避免测试依赖已删除的后备文件接口。 */
export function createReviewStore(workDir: string, number = 42, dataDir = resolveDataDir()) {
  const tracker = newTracker(dataDir);
  tracker.create({
    lifecycle: { kind: 'running', phase: 'plan' }, branchName: `iaf-${number}`, pipelineMode: 'plan-mode',
    demandSpec: { demandId: `gh-${number}`, title: '审核测试', description: '核对计划与反馈', createdAt: new Date().toISOString(), sourceRef: { source: 'github-issue', externalId: String(number), displayId: String(number) } },
  });
  const plan = new PlanPersistence(workDir, number, dataDir, tracker);
  function appendFeedback(feedback: string, planSnapshot = '完整计划：实现功能并补充边界测试', reviewedSessionId?: string) {
    tracker.store.savePlan(number, JSON.parse(structuredPlanOutput(planSnapshot)), tracker.get(number)!.run!.version);
    tracker.transaction(number, record => {
      const run = record.run!;
      run.review!.decision = 'rejected';
      run.review!.feedback = feedback;
      run.reviewHistory ??= [];
      run.reviewHistory.push({ round: run.reviewHistory.length + 1, revision: run.planRevision, feedback, timestamp: new Date().toISOString(), planSnapshot, reviewedSessionId });
    });
  }
  return { plan, tracker, appendFeedback };
}
