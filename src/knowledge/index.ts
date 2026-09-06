export type { ProjectKnowledge, RuleTriggerConfig, KnownIssueConfig } from './ProjectKnowledge.js';
export type {
  KnowledgeEntry,
  KnowledgeEntryMeta,
  KnowledgeEntryType,
  KnowledgeIndex,
  KnowledgeStats,
  KnowledgeEntrySource,
} from './KnowledgeEntry.js';
export { KNOWLEDGE_DEFAULTS } from './KnowledgeDefaults.js';
export {
  loadKnowledge,
  getProjectKnowledge,
  reloadKnowledge,
  resetKnowledgeCache,
} from './KnowledgeLoader.js';
export { KnowledgeStore, projectKnowledgeToMarkdown } from './KnowledgeStore.js';
