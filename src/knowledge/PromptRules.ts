import path from 'node:path';
import { KnowledgeStore } from './KnowledgeStore.js';
import { getProjectKnowledge } from './index.js';
import { resolveDataDir } from '../paths.js';

/** 父阶段、子任务和集成修复共用知识开关。 */
export function resolvePromptRules(enabled: boolean): string | null {
  if (!enabled) return null;
  const store = new KnowledgeStore(path.join(resolveDataDir(), 'knowledge'));
  const rules = store
    .getAllEntries()
    .filter(
      (entry) =>
        entry.type === 'custom' || (entry.type === 'agent-rule' && entry.tags.includes('enabled')),
    );
  const project = getProjectKnowledge();
  const context = project
    ? `项目说明：${project.businessContext.purpose}\n技术栈：${project.structure.primaryLanguage} ${project.structure.frameworks.join('、')}\n${project.agentKnowledge.conventions.join('\n')}`
    : '';
  return (
    [
      context,
      ...rules.map((entry) => {
        try {
          const rule = JSON.parse(entry.content);
          return rule.deprecated ? '' : rule.content;
        } catch {
          return entry.content;
        }
      }),
    ]
      .filter(Boolean)
      .join('\n\n') || null
  );
}
