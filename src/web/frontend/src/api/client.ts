import type {
  IssueRecord,
  SystemStatus,
  AgentLogEntry,
  SupplementInfo,
  ExecutableTask,
} from '@/types';
import type { IssueGraphs } from '../../../../shared/workflowGraphs.js';
import type { UatResult } from '../../../../shared/workbench.js';
import { request, json } from './http';

async function post<T = { success: boolean; message?: string }>(
  url: string,
  body?: unknown,
): Promise<T> {
  return json<T>(url, 'POST', body);
}

export async function fetchTasks(signal?: AbortSignal): Promise<ExecutableTask[]> {
  return request<ExecutableTask[]>('/api/tasks', { signal });
}

export async function fetchIssueDetail(number: number, signal?: AbortSignal): Promise<IssueRecord> {
  return request<IssueRecord>(`/api/issues/${number}`, { signal });
}

export async function fetchIssueLogs(
  number: number, signal?: AbortSignal,
): Promise<AgentLogEntry[]> {
  return request<AgentLogEntry[]>(`/api/issues/${number}/logs`, { signal });
}

export async function fetchIssueGraphs(number: number, signal?: AbortSignal): Promise<IssueGraphs> {
  return request<IssueGraphs>(`/api/issues/${number}/graphs`, { signal });
}

export async function fetchUatRuns(number: number): Promise<UatResult[]> {
  const result = await request<{ runs: UatResult[] }>(`/api/issues/${number}/uat-runs`);
  return result.runs;
}

export async function fetchSystemStatus(): Promise<SystemStatus> {
  return request<SystemStatus>('/api/system/status');
}

export interface SettingsResponse {
  values: Record<string, string>;
  restartRequired: boolean;
}

export async function fetchSettings(): Promise<SettingsResponse> {
  return request<SettingsResponse>('/api/settings');
}

export async function saveSettings(
  values: Record<string, string>,
): Promise<{ success: boolean; restartRequired: boolean }> {
  return json('/api/settings', 'PUT', { values });
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

export async function rejectPlan(
  number: number,
  feedback: string,
  planRevision: number,
): Promise<void> {
  await post(`/api/issues/${number}/reject-plan`, { feedback, planRevision });
}

export async function fetchSupplement(
  number: number, signal?: AbortSignal,
): Promise<SupplementInfo | null> {
  return request<SupplementInfo | null>(`/api/issues/${number}/supplement`, { signal });
}

export async function saveSupplement(
  number: number,
  data: SupplementInfo,
): Promise<{ success: boolean; data: SupplementInfo }> {
  return request(`/api/issues/${number}/supplement`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function restartPreview(
  number: number,
): Promise<{ success: boolean; previewUrl: string }> {
  return post(`/api/issues/${number}/restart-preview`);
}

export async function stopPreview(number: number): Promise<void> {
  await post(`/api/issues/${number}/stop-preview`);
}
