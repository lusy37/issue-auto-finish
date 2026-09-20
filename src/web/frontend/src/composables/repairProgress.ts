import type { IssueRecord } from '@/types';

export interface VerifyFixLoopState {
  active: boolean;
  iteration: number;
  maxIterations: number;
  lastPassed: boolean;
}

/** 修复轮次投影自聚合记录，刷新和重启后无需补发旧事件。 */
export function repairProgress(issue: IssueRecord | null, maxIterations: number): VerifyFixLoopState | undefined {
  const run = issue?.run;
  if (!issue || !run?.repairRounds) return undefined;
  return {
    iteration: run.repairRounds,
    maxIterations,
    active: issue.lifecycle.kind === 'running' && run.buildEntry === 'repair-integration',
    lastPassed: !!run.candidateCommit && run.verify?.commit === run.candidateCommit
      && (!run.workflow.definition?.phaseIds.includes('uat') || run.uat?.commit === run.candidateCommit),
  };
}
