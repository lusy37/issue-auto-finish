import type { KnowledgeEntry as StoredKnowledgeEntry } from '../knowledge/KnowledgeEntry.js';
import type { MemoryEntry, AgentRuleEntry } from '../distill/types.js';
import type { DistillScheduler } from '../distill/DistillScheduler.js';
export type { KnowledgeEntryType } from '../knowledge/KnowledgeEntry.js';
export type { DiaryEntry } from '../distill/types.js';
export type { ProjectProfile } from '../knowledge/ProjectProfile.js';

/** 知识接口在存储字段上补充展示用的记忆和规则信息。 */
export interface KnowledgeEntry extends StoredKnowledgeEntry {
  memory?: Pick<MemoryEntry, 'confidence' | 'evidence'>;
  deprecated?: AgentRuleEntry['deprecated'];
}
export type DistillStatus = ReturnType<DistillScheduler['getStatus']>;
