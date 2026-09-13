import { IssueWorkflow } from '../../src/orchestrator/IssueWorkflow.js';
import type { IssueTracker } from '../../src/tracker/IssueTracker.js';

/** 为只关注审核的测试建立真正的图中断，不直接伪造框架检查点。 */
export async function suspendAtReview(tracker: IssueTracker, number: number): Promise<void> {
  tracker.transaction(number, record => {
    record.run!.workflow.generation++;
    record.run!.workflow.entry = 'review';
  });
  await new IssueWorkflow({
    tracker, number, maxRetries: 0, maxRepairs: 0,
    context: { issueIid: number, demand: tracker.get(number)!.demandSpec, branchName: 'test', workDir: tracker.store.dataDir },
    runner: { run: async () => { throw new Error('审核测试不应执行 AI 阶段'); } },
  }).drive();
}
