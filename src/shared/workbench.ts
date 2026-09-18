export type { IssueRun, ExecutionIdentity, TaskDefinition, TaskRun } from '../dag/contracts.js';
/** 前后端共用的数据契约；仅包含类型，浏览器不会加载服务端执行逻辑。 */
export type { IssueLifecycle } from '../tracker/IssueLifecycle.js';
export type { PhaseHistoryEntry } from '../orchestration/PhaseHistory.js';

export interface DemandDraft {
  format: 'iaf-mini/draft/v2';
  id: string;
  input: string;
  createdAt: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  status: 'draft' | 'unknown' | 'created';
  marker: string;
  creationRequestedAt?: string;
  issueIid?: number;
  issueUrl?: string;
  error?: string;
}

export interface UatResult {
  failureKind?: 'assertion' | 'environment';
  runId: string;
  issueIid: number;
  passed: boolean;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  screenshots?: string[];
  reportAvailable?: boolean;
  startedAt: string;
  finishedAt: string;
  error?: string;
}

export interface TaskSummary {
  range: '7d' | '30d' | 'all';
  total: number;
  completed: number;
  failed: number;
  successRate: number | null;
  totalDurationMs: number;
  averageDurationMs: number | null;
  retries: number;
  interventions: number;
  phases: Record<
    string,
    { runs: number; durationMs: number; failures: number }
  >;
  uat: { passed: number; failed: number; passRate: number | null };
}
