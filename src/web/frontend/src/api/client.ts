import { ARTIFACTS } from '../../../../shared/runtime/artifacts.js';
import type {
  IssueRecord, SystemStatus, AgentLogEntry,
  GitHubIssue, SupplementInfo, ReviewRound,
  PipelineMeta,
  ExecutableTask, TaskKind,
} from '@/types';
import { request, json } from './http';

async function post<T = { success: boolean; message?: string }>(
  url: string, body?: unknown,
): Promise<T> {
  return json<T>(url, 'POST', body);
}

export async function fetchTasks(
  params?: { kind?: TaskKind; status?: string },
): Promise<ExecutableTask[]> {
  const qs = new URLSearchParams();
  if (params?.kind) qs.set('kind', params.kind);
  if (params?.status) qs.set('status', params.status);
  const query = qs.toString();
  return request<ExecutableTask[]>('/api/tasks' + (query ? '?' + query : ''));
}

export async function fetchPipelineMeta(): Promise<PipelineMeta> {
  return request<PipelineMeta>('/api/pipeline-meta');
}

export async function fetchIssueDetail(number: number): Promise<IssueRecord> {
  return request<IssueRecord>(`/api/issues/${number}`);
}

export async function fetchIssueLogs(number: number): Promise<AgentLogEntry[]> {
  return request<AgentLogEntry[]>(`/api/issues/${number}/logs`);
}

export async function fetchSystemStatus(): Promise<SystemStatus> {
  return request<SystemStatus>('/api/system/status');
}

export async function startSkippedIssue(number: number): Promise<void> {
  await post(`/api/issues/${number}/start`);
}

export async function retryIssue(number: number): Promise<void> {
  await post(`/api/issues/${number}/retry`);
}

export async function cancelIssue(number: number): Promise<void> {
  await post(`/api/issues/${number}/cancel`);
}

export async function restartIssue(number: number): Promise<void> {
  await post(`/api/issues/${number}/restart`);
}

export async function retryFromPhase(number: number, phase: string): Promise<void> {
  await post(`/api/issues/${number}/retry-from-phase`, { phase });
}

export async function abortIssue(number: number): Promise<void> {
  await post(`/api/issues/${number}/abort`);
}

export async function continueIssue(number: number): Promise<void> {
  await post(`/api/issues/${number}/continue`);
}

export async function redoPhase(number: number): Promise<void> {
  await post(`/api/issues/${number}/redo-phase`);
}

export async function approvePlan(number: number, planRevision: number): Promise<void> {
  await post(`/api/issues/${number}/approve-plan`, { planRevision });
}

export async function rejectPlan(number: number, feedback: string, planRevision: number): Promise<void> {
  await post(`/api/issues/${number}/reject-plan`, { feedback, planRevision });
}

export async function skipReview(number: number, planRevision: number): Promise<void> {
  await post(`/api/issues/${number}/skip-review`, { planRevision });
}

export async function fetchReviewHistory(number: number): Promise<ReviewRound[]> {
  return request<ReviewRound[]>(`/api/issues/${number}/review-history`);
}

export interface PlanDiff {
  diff: string;
  hasChanges: boolean;
}

export async function fetchPlanDiff(number: number, file = ARTIFACTS.plan.filename): Promise<PlanDiff> {
  const url = `/api/issues/${number}/plan-diff?file=${encodeURIComponent(file)}`;
  return request<PlanDiff>(url);
}

export async function loadPlanDoc(number: number, filename: string, format: 'html' | 'raw' = 'html'): Promise<string> {
  const url = format === 'html'
    ? `/api/issues/${number}/plans/${filename}?format=html`
    : `/api/issues/${number}/plans/${filename}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as Record<string, string>).error || 'Failed to load');
  }
  return res.text();
}

export async function savePlanDoc(number: number, filename: string, content: string): Promise<void> {
  await request(`/api/issues/${number}/plans/${filename}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

export async function fetchSupplement(number: number): Promise<SupplementInfo> {
  return request<SupplementInfo>(`/api/issues/${number}/supplement`);
}

export async function saveSupplement(
  number: number, data: SupplementInfo,
): Promise<{ success: boolean; data: SupplementInfo }> {
  return request(`/api/issues/${number}/supplement`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export interface BrowseResult {
  issues: GitHubIssue[];
  total: number;
  trackedIids: number[];
}

export async function fetchGitHubIssues(
  params: { search?: string; page?: number; perPage?: number },
): Promise<BrowseResult> {
  const qs = new URLSearchParams();
  if (params.search) qs.set('search', params.search);
  qs.set('page', String(params.page ?? 1));
  qs.set('per_page', String(params.perPage ?? 20));
  return request<BrowseResult>(`/api/github/issues?${qs.toString()}`);
}

export interface StartIssueParams {
  issueId: number;
  issueIid: number;
  issueTitle: string;
  supplement?: Partial<SupplementInfo>;
}

export async function startIssue(params: StartIssueParams): Promise<{ success: boolean; record: IssueRecord }> {
  return post(`/api/issues/start`, params);
}

export async function setIssueNoteSync(
  number: number, enabled: boolean | null,
): Promise<{ success: boolean; issueNoteSyncEnabled: boolean | null }> {
  return request(`/api/issues/${number}/note-sync`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

export async function setSystemNoteSync(
  enabled: boolean,
): Promise<{ success: boolean; issueNoteSyncEnabled: boolean }> {
  return request('/api/system/note-sync', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

export async function restartPreview(number: number): Promise<{ success: boolean; previewUrl: string }> {
  return post(`/api/issues/${number}/restart-preview`);
}

export async function rebuildWorktree(number: number): Promise<{ success: boolean; worktree: { exists: boolean; cleanedAt?: string; path?: string; ideUrl?: string } }> {
  return post(`/api/issues/${number}/rebuild-worktree`);
}

export async function stopPreview(number: number): Promise<void> {
  await post(`/api/issues/${number}/stop-preview`);
}
