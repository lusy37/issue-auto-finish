export { json } from './http';
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
export interface KnowledgeItem {
  id: string;
  title: string;
  content: string;
  type: string;
  tags: string[];
  deprecated?: boolean;
}
export interface UatRun {
  runId: string;
  passed: boolean;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  startedAt: string;
  finishedAt: string;
  error?: string;
  screenshots?: string[];
  reportAvailable?: boolean;
}
export interface TaskSummary {
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
