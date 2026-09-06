export type KnowledgeEntryType =
  | 'project-meta' | 'custom'
  | 'diary'        // Layer 1: 原始 Issue 经验日记
  | 'memory'       // Layer 2: 蒸馏后的模式记忆
  | 'agent-rule';  // Layer 3: 可执行的 Agent 规则

export interface KnowledgeEntrySource {
  url?: string;
  kind?: 'local';
}

export interface KnowledgeEntryMeta {
  id: string;
  type: KnowledgeEntryType;
  title: string;
  tags: string[];
  source?: KnowledgeEntrySource;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeEntry extends KnowledgeEntryMeta {
  content: string;
}

export interface KnowledgeIndex {
  version: 1;
  lastAnalyzedAt?: string;
  entries: KnowledgeEntryMeta[];
}

export interface KnowledgeStats {
  total: number;
  byType: Record<KnowledgeEntryType, number>;
  lastAnalyzedAt?: string;
}
