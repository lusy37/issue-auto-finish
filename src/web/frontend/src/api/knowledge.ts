import { json } from './http';

export type KnowledgeEntryType = 'project-meta' | 'custom' | 'diary' | 'memory' | 'agent-rule';

export interface KnowledgeEntry {
  id: string;
  type: KnowledgeEntryType;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  memory?: { confidence: number; evidence: string[] };
  deprecated?: boolean;
}

export const knowledgeLabels: Record<KnowledgeEntryType, string> = {
  'project-meta': '项目分析',
  custom: '自定义知识',
  diary: '执行日记',
  memory: '经验记忆',
  'agent-rule': 'Agent 规则',
};

export interface ProjectProfile {
  description: string;
  language: string;
  frameworks: string[];
  installCommand: string;
  lintCommand: string;
  buildCommand: string;
  testCommand: string;
  rules: string;
}

export interface DistillStatus {
  enabled: boolean;
  running: boolean;
  diaryCount: number;
  undistilledDiaryCount: number;
  memoryCount: number;
  ruleCount: number;
  runs: Array<{
    id: string;
    startedAt: string;
    finishedAt?: string;
    status: 'running' | 'completed' | 'failed';
    error?: string;
  }>;
}

export interface DiaryEntry {
  id: string;
  issueIid: number;
  issueTitle: string;
  outcome: 'completed' | 'failed';
  prUrl?: string;
  artifactSummary?: string;
  humanInterventions: Array<{ type: string; detail: string; timestamp: string }>;
  distilled: boolean;
  createdAt: string;
  failure?: { failedAtPhase: string; error: string; attempts: number };
}

export async function fetchKnowledge(): Promise<KnowledgeEntry[]> {
  const result = await json<{ entries: KnowledgeEntry[] }>('/api/knowledge');
  return result.entries;
}

export function fetchProjectProfile(): Promise<ProjectProfile> {
  return json('/api/project-profile');
}

export function saveProjectProfile(profile: ProjectProfile): Promise<ProjectProfile> {
  return json('/api/project-profile', 'PUT', profile);
}

export function createKnowledge(
  input: Pick<KnowledgeEntry, 'title' | 'content' | 'tags'>,
): Promise<KnowledgeEntry> {
  return json('/api/knowledge', 'POST', input);
}

export function updateKnowledge(
  id: string,
  input: Pick<KnowledgeEntry, 'title' | 'content' | 'tags'>,
): Promise<KnowledgeEntry> {
  return json(`/api/knowledge/${encodeURIComponent(id)}`, 'PUT', input);
}

export function deleteKnowledge(id: string): Promise<{ success: boolean }> {
  return json(`/api/knowledge/${encodeURIComponent(id)}`, 'DELETE');
}

export async function setRuleEnabled(id: string, enabled: boolean): Promise<KnowledgeEntry> {
  const entry = await json<KnowledgeEntry>(
    `/api/knowledge/${encodeURIComponent(id)}/enabled`, 'PUT', { enabled },
  );
  return entry;
}

export async function fetchDistillStatus(): Promise<DistillStatus> {
  const result = await json<{ status: DistillStatus }>('/api/distill/status');
  return result.status;
}

export async function fetchDiaries(): Promise<DiaryEntry[]> {
  const result = await json<{ diaries: DiaryEntry[] }>('/api/distill/diaries');
  return result.diaries;
}

export function runDistill(): Promise<{ memory: unknown; rule: unknown }> {
  return json('/api/distill/run', 'POST');
}
