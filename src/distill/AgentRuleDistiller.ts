import { buildCallOptions, type AICallPolicy } from '../ai-runner/CallPolicy.js';
import { parseJsonOutput } from '../prompts/parseJsonOutput.js';
import { ruleOutputSchema, RULE_OUTPUT_SCHEMA } from './ActionSchema.js';
/**
 * AgentRuleDistiller — Layer 3: 从成熟 memory 提取可执行的 Agent 规则。
 *
 * 筛选满足条件的 memory，通过 AI 判断哪些可以升级为 Markdown 规则，
 * 并保存为本地 Markdown，用户启用后进入任务提示词。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logger as rootLogger } from '../logger.js';
import type { AIRunner } from '../ai-runner/AIRunner.js';
import type { KnowledgeStore } from '../knowledge/KnowledgeStore.js';
import type { VersionStore } from './VersionStore.js';
import type { MemoryEntry, AgentRuleEntry, RuleDistillAction } from './types.js';
import { buildRuleDistillPrompt } from './prompts/rule-distill.js';
import { resolveDataDir, ensureDir } from '../paths.js';

const logger = rootLogger.child('AgentRuleDistiller');

export interface AgentRuleDistillerDeps {
  aiRunner: AIRunner;
  knowledgeStore: KnowledgeStore;
  versionStore: VersionStore;
  workDir: string;
  aiPolicy: AICallPolicy;
  confidenceThreshold: number;
  /** 本地规则目录（默认位于数据目录） */
  rulesDir?: string;
}

export class AgentRuleDistiller {
  private aiRunner: AIRunner;
  private knowledgeStore: KnowledgeStore;
  private versionStore: VersionStore;
  private workDir: string;
  private aiPolicy: AICallPolicy;
  private confidenceThreshold: number;
  private rulesDir: string;

  constructor(deps: AgentRuleDistillerDeps) {
    this.aiRunner = deps.aiRunner;
    this.knowledgeStore = deps.knowledgeStore;
    this.versionStore = deps.versionStore;
    this.workDir = deps.workDir;
    this.aiPolicy = deps.aiPolicy;
    this.confidenceThreshold = deps.confidenceThreshold;
    this.rulesDir = deps.rulesDir ?? path.join(resolveDataDir(), 'rules');
  }

  /**
   * 执行规则蒸馏。
   * @returns 处理的 memory 数和创建/更新的 rule 数。
   */
  async distill(): Promise<{ processedMemories: number; actions: number }> {
    const entries = this.knowledgeStore.getAllEntries();
    const memories = entries
      .filter((entry) => entry.type === 'memory')
      .map((entry) => JSON.parse(entry.content) as MemoryEntry);
    const superseded = new Set(memories.flatMap((memory) => memory.supersedes ?? []));
    const matureMemories = memories.filter((memory) => (
      memory.confidence >= this.confidenceThreshold
      && !memory.promotedToRule
      && !superseded.has(memory.id)
    ));
    if (matureMemories.length === 0) {
      logger.info('No mature memories ready for rule distillation');
      return { processedMemories: 0, actions: 0 };
    }
    const existingRules = entries
      .filter((entry) => entry.type === 'agent-rule')
      .map((entry) => JSON.parse(entry.content) as AgentRuleEntry);

    logger.info('Starting rule distillation', {
      matureMemories: matureMemories.length,
      existingRules: existingRules.length,
    });

    // 构建 prompt
    const prompt = buildRuleDistillPrompt(matureMemories, existingRules);

    // 调用 AI
    const result = await this.aiRunner.run({
      prompt,
      workDir: this.workDir,
      ...buildCallOptions(this.aiPolicy, 'rule-distill'),
      outputSchema: RULE_OUTPUT_SCHEMA,
    });

    if (!result.success) {
      const detail = (result.errorMessage || result.output || '').trim();
      logger.error('AI rule distillation failed', {
        error: detail || 'AI runner 未返回错误详情',
        exitCode: result.exitCode,
        timeoutType: result.timeoutType,
      });
      throw new Error(
        `Rule distillation AI call failed: ${detail || 'AI runner 未返回错误详情'}`,
      );
    }

    // 解析 actions
    const actions = this.parseActions(result.output);
    if (actions.length === 0) {
      logger.info('No rule distillation actions returned by AI');
      return { processedMemories: matureMemories.length, actions: 0 };
    }

    // 执行 actions
    let actionCount = 0;
    for (const action of actions) {
      try {
        this.executeAction(action, existingRules);
        actionCount++;
      } catch (err) {
        logger.warn('Failed to execute rule distill action', {
          action: action.type,
          error: (err as Error).message,
        });
        throw err;
      }
    }

    logger.info('Rule distillation complete', {
      processedMemories: matureMemories.length,
      actions: actionCount,
    });

    return { processedMemories: matureMemories.length, actions: actionCount };
  }

  /** 解析 AI 输出 */
  private parseActions(output: string): RuleDistillAction[] {
    try {
      const parsed = parseJsonOutput(output);
      return ruleOutputSchema.parse(parsed).actions;
    } catch (err) {
      logger.warn('Failed to parse AI rule distill output', {
        error: (err as Error).message,
      });
      throw new Error(`无法解析规则蒸馏结果：${(err as Error).message}`);
    }
  }

  /** 执行单个 action */
  private executeAction(action: RuleDistillAction, existingRules: AgentRuleEntry[]): void {
    switch (action.type) {
      case 'CREATE':
        this.createRule(action);
        break;
      case 'UPDATE':
        this.updateRule(action, existingRules);
        break;
      case 'DEPRECATE':
        this.deprecateRule(action, existingRules);
        break;
      default:
        logger.warn('Unknown rule distill action type', {
          type: (action as { type: string }).type,
        });
    }
  }

  /** 创建新规则 */
  private createRule(action: Extract<RuleDistillAction, { type: 'CREATE' }>): void {
    const ruleEntry: AgentRuleEntry = {
      id: randomUUID(),
      ruleName: action.ruleName,
      title: action.title,
      content: action.content,
      sourceMemoryIds: action.sourceMemoryIds,
      keywords: action.keywords,
      alwaysApply: action.alwaysApply,
      version: 1,
      deprecated: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // 存储到 KnowledgeStore
    this.knowledgeStore.create({
      id: ruleEntry.id,
      type: 'agent-rule',
      title: action.title,
      content: JSON.stringify(ruleEntry),
      tags: [...action.keywords, 'rule:' + action.ruleName],
    });

    // 同步 Markdown 文件
    this.writeMarkdownRule(ruleEntry);

    // 标记来源 memory 为已提升
    this.markMemoriesPromoted(action.sourceMemoryIds);

    // 版本记录
    this.versionStore.append({
      entryId: ruleEntry.id,
      version: 1,
      content: action.content,
      action: 'created',
      timestamp: new Date().toISOString(),
    });

    logger.info('Created agent rule', { id: ruleEntry.id, ruleName: action.ruleName });
  }

  /** 更新已有规则 */
  private updateRule(
    action: Extract<RuleDistillAction, { type: 'UPDATE' }>,
    existingRules: AgentRuleEntry[],
  ): void {
    const existing = existingRules.find((r) => r.id === action.ruleId);
    if (!existing) {
      logger.warn('Cannot update: rule not found', { ruleId: action.ruleId });
      return;
    }

    existing.content = action.content;
    if (action.keywords) existing.keywords = action.keywords;
    existing.version++;
    existing.updatedAt = new Date().toISOString();

    this.knowledgeStore.update(existing.id, { content: JSON.stringify(existing) });

    // 同步 Markdown 文件
    this.writeMarkdownRule(existing);

    // 版本记录
    this.versionStore.append({
      entryId: existing.id,
      version: existing.version,
      content: action.content,
      action: 'merged',
      timestamp: new Date().toISOString(),
    });

    logger.info('Updated agent rule', { id: existing.id, ruleName: existing.ruleName });
  }

  /** 废弃规则 */
  private deprecateRule(
    action: Extract<RuleDistillAction, { type: 'DEPRECATE' }>,
    existingRules: AgentRuleEntry[],
  ): void {
    const existing = existingRules.find((r) => r.id === action.ruleId);
    if (!existing) {
      logger.warn('Cannot deprecate: rule not found', { ruleId: action.ruleId });
      return;
    }

    existing.deprecated = true;
    existing.updatedAt = new Date().toISOString();

    this.knowledgeStore.update(existing.id, { content: JSON.stringify(existing) });

    // 删除 Markdown 文件
    this.removeMarkdownRule(existing.id);

    // 版本记录
    this.versionStore.append({
      entryId: existing.id,
      version: existing.version,
      content: existing.content,
      action: 'deprecated',
      reason: action.reason,
      timestamp: new Date().toISOString(),
    });

    logger.info('Deprecated agent rule', { id: existing.id, reason: action.reason });
  }

  /** 同步规则到 DATA_DIR/rules/ Markdown 文件，仅保存在本地 */
  private writeMarkdownRule(rule: AgentRuleEntry): void {
    const markdown = `# ${rule.title}\n\n${rule.content}\n`;

    // Write to DATA_DIR/rules/
    try {
      ensureDir(this.rulesDir);
      const filePath = path.join(this.rulesDir, `distilled-${rule.id}.md`);
      fs.writeFileSync(filePath, markdown, 'utf-8');
      logger.debug('Synced Markdown file', { path: filePath });
    } catch (err) {
      logger.warn('Failed to sync Markdown file', {
        ruleName: rule.ruleName,
        error: (err as Error).message,
      });
    }
  }

  /** 删除 Markdown 文件（本地数据目录） */
  private removeMarkdownRule(ruleName: string): void {
    const fileName = `distilled-${ruleName}.md`;

    // Remove from DATA_DIR/rules/
    try {
      const filePath = path.join(this.rulesDir, fileName);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logger.debug('Removed Markdown file', { path: filePath });
      }
    } catch (err) {
      logger.warn('Failed to remove Markdown file', {
        ruleName,
        error: (err as Error).message,
      });
    }
  }

  /** 标记来源 memory 为已提升为规则 */
  private markMemoriesPromoted(memoryIds: string[]): void {
    for (const id of memoryIds) {
      const entry = this.knowledgeStore.get(id);
      if (!entry) continue;
      const memory = JSON.parse(entry.content) as MemoryEntry;
      if (!memory.promotedToRule) {
        memory.promotedToRule = true;
        memory.updatedAt = new Date().toISOString();
        this.knowledgeStore.update(id, { content: JSON.stringify(memory) });
      }
    }
  }
}
