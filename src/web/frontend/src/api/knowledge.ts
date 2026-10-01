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
}

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

export function setRuleEnabled(id: string, enabled: boolean): Promise<KnowledgeEntry> {
  return json(`/api/knowledge/${encodeURIComponent(id)}/enabled`, 'PUT', { enabled });
}
