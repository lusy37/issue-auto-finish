/** 前后端共用的数据契约；仅包含类型，浏览器不会加载服务端执行逻辑。 */
import type {IssueState as StoredIssueState} from '../tracker/IssueState.js';
export type { PhaseHistoryEntry } from '../orchestration/OrchestrationState.js';
export type IssueState = `${StoredIssueState}`;

export interface TaskDraft {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  status: "draft" | "creating" | "created" | "failed" | "unknown";
  issueIid?: number;
  issueUrl?: string;
  error?: string;
}

export interface DraftBatch {
  id: string;
  input: string;
  createdAt: string;
  tasks: TaskDraft[];
}

export interface UatResult {
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
