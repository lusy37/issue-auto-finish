import type { PhaseResult,PhaseRunner,PhaseRunnerContext,PhaseSpec } from '../../src/orchestration/index.js';
import type { OrchestratorDeps } from '../../src/orchestrator/IssueProcessingContext.js';
import { structuredPlanOutput } from './structured-plan.js';

/** 外层调度测试的阶段替身；任务合并及验收由真实 Git/UAT 集成测试独立覆盖。 */
export function isolatedPhaseRunner(execute: (context: PhaseRunnerContext) => Promise<PhaseResult>): new (deps: OrchestratorDeps) => PhaseRunner {
  return class {
    constructor(private deps: OrchestratorDeps) {}
    async run(spec: PhaseSpec, context: PhaseRunnerContext): Promise<PhaseResult> {
      if (spec.kind === 'gate') throw new Error('审核必须由 LangGraph interrupt 执行');
      const result = await execute(context);
      if (spec.id === 'plan' && result.kind === 'completed') {
        const content = JSON.parse(structuredPlanOutput(result.output));
        this.deps.tracker.store.savePlan(context.issueIid, content, this.deps.tracker.get(context.issueIid)!.run!.version);
      }
      return result;
    }
  };
}
