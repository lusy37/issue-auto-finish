import { buildCallOptions, type AICallPolicy } from '../ai-runner/CallPolicy.js';
import { parseJsonOutput } from '../prompts/parseJsonOutput.js';
import { memoryActionsSchema } from './ActionSchema.js';
/**
 * MemoryDistiller — Layer 2: 批量分析日记，提取共性模式。
 *
 * 从 DiaryStore 获取未蒸馏的日记，通过 AI 识别模式并生成/更新 memory 条目。
 * memory 条目存储在 KnowledgeStore 中（type='memory'）。
 */
import { randomUUID } from 'node:crypto';
import { logger as rootLogger } from '../logger.js';
import type { AIRunner } from '../ai-runner/AIRunner.js';
import type { KnowledgeStore } from '../knowledge/KnowledgeStore.js';
import type { DiaryStore } from './DiaryStore.js';
import type { VersionStore } from './VersionStore.js';
import type { MemoryEntry, MemoryDistillAction } from './types.js';
import { buildMemoryDistillPrompt } from './prompts/memory-distill.js';

const logger = rootLogger.child('MemoryDistiller');

export interface MemoryDistillerDeps {
  aiRunner: AIRunner;
  diaryStore: DiaryStore;
  knowledgeStore: KnowledgeStore;
  versionStore: VersionStore;
  workDir: string;
  aiPolicy: AICallPolicy;
  minDiariesForDistill: number;
}

export class MemoryDistiller {
  private aiRunner: AIRunner;
  private diaryStore: DiaryStore;
  private knowledgeStore: KnowledgeStore;
  private versionStore: VersionStore;
  private workDir: string;
  private aiPolicy: AICallPolicy;
  private minDiariesForDistill: number;

  constructor(deps: MemoryDistillerDeps) {
    this.aiRunner = deps.aiRunner;
    this.diaryStore = deps.diaryStore;
    this.knowledgeStore = deps.knowledgeStore;
    this.versionStore = deps.versionStore;
    this.workDir = deps.workDir;
    this.aiPolicy = deps.aiPolicy;
    this.minDiariesForDistill = deps.minDiariesForDistill;
  }

  /**
   * 执行记忆蒸馏。
   * @returns 处理的日记数和创建/更新的 memory 数。
   */
  async distill(options?: {
    force?: boolean;
  }): Promise<{ processedDiaries: number; actions: number }> {
    const undistilled = this.diaryStore.getUndistilled();

    // force 模式跳过阈值检查（手动触发）
    if (!options?.force && undistilled.length < this.minDiariesForDistill) {
      logger.info('Not enough undistilled diaries, skipping memory distillation', {
        count: undistilled.length,
        threshold: this.minDiariesForDistill,
      });
      return { processedDiaries: 0, actions: 0 };
    }

    // force 模式下，如果没有任何日记，也要提前返回
    if (undistilled.length === 0) {
      logger.info('No undistilled diaries available');
      return { processedDiaries: 0, actions: 0 };
    }

    logger.info('Starting memory distillation', { diaryCount: undistilled.length });

    // 获取现有 memory 列表
    const existingMemories = this.loadExistingMemories();

    // 构建 prompt
    const prompt = buildMemoryDistillPrompt(undistilled, existingMemories);

    // 调用 AI
    const result = await this.aiRunner.run({
      prompt,
      workDir: this.workDir,
      ...buildCallOptions(this.aiPolicy, 'memory-distill'),
    });

    if (!result.success) {
      const detail = (result.errorMessage || result.output || '').trim();
      logger.error('AI distillation failed', {
        error: detail || 'AI runner 未返回错误详情',
        exitCode: result.exitCode,
        timeoutType: result.timeoutType,
      });
      throw new Error(
        `Memory distillation AI call failed: ${detail || 'AI runner 未返回错误详情'}`,
      );
    }

    // 解析 AI 输出
    const actions = this.parseActions(result.output);
    if (actions.length === 0) {
      logger.info('No distillation actions returned by AI');
      // 仍然标记日记为已蒸馏
      this.diaryStore.markDistilled(undistilled.map((d) => d.id));
      return { processedDiaries: undistilled.length, actions: 0 };
    }

    // 执行 actions
    let actionCount = 0;
    for (const action of actions) {
      try {
        this.executeAction(action, existingMemories);
        actionCount++;
      } catch (err) {
        logger.warn('Failed to execute distill action', {
          action: action.type,
          error: (err as Error).message,
        });
        throw err;
      }
    }

    // 标记日记为已蒸馏
    this.diaryStore.markDistilled(undistilled.map((d) => d.id));

    logger.info('Memory distillation complete', {
      processedDiaries: undistilled.length,
      actions: actionCount,
    });

    return { processedDiaries: undistilled.length, actions: actionCount };
  }

  /** 从 KnowledgeStore 加载现有 memory 条目 */
  private loadExistingMemories(): MemoryEntry[] {
    const entries = this.knowledgeStore.list('memory');
    return entries
      .map((meta) => {
        const full = this.knowledgeStore.get(meta.id);
        if (!full) return null;
        try {
          return JSON.parse(full.content) as MemoryEntry;
        } catch {
          return null;
        }
      })
      .filter((m): m is MemoryEntry => m !== null);
  }

  /** 解析 AI 输出的 actions */
  private parseActions(output: string): MemoryDistillAction[] {
    try {
      const parsed = parseJsonOutput(output);
      if (!parsed || typeof parsed !== 'object' || !('actions' in parsed))
        throw new Error('蒸馏结果缺少 actions');
      return memoryActionsSchema.parse(parsed.actions);
    } catch (err) {
      logger.warn('Failed to parse AI distillation output', {
        error: (err as Error).message,
        output: output.slice(0, 300),
      });
      throw new Error(`无法解析蒸馏结果：${(err as Error).message}`);
    }
  }

  /** 执行单个 action */
  private executeAction(action: MemoryDistillAction, existingMemories: MemoryEntry[]): void {
    switch (action.type) {
      case 'CREATE':
        this.createMemory(action);
        break;
      case 'MERGE':
        this.mergeMemory(action, existingMemories);
        break;
      case 'SUPERSEDE':
        this.supersedeMemory(action, existingMemories);
        break;
      default:
        throw new Error('不支持的蒸馏操作类型');
    }
  }

  /** 创建新 memory */
  private createMemory(action: Extract<MemoryDistillAction, { type: 'CREATE' }>): void {
    const memoryEntry: MemoryEntry = {
      id: randomUUID(),
      theme: action.theme,
      title: action.title,
      content: action.content,
      evidence: action.diaryIds,
      confidence: Math.min(1, action.diaryIds.length * 0.2),
      version: 1,
      promotedToRule: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.knowledgeStore.create({
      type: 'memory',
      title: action.title,
      content: JSON.stringify(memoryEntry),
      tags: [action.theme],
    });

    this.versionStore.append({
      entryId: memoryEntry.id,
      version: 1,
      content: action.content,
      action: 'created',
      timestamp: new Date().toISOString(),
    });

    logger.info('Created new memory', {
      id: memoryEntry.id,
      theme: action.theme,
      title: action.title,
    });
  }

  /** 合并新证据到已有 memory */
  private mergeMemory(
    action: Extract<MemoryDistillAction, { type: 'MERGE' }>,
    existingMemories: MemoryEntry[],
  ): void {
    const existing = existingMemories.find((m) => m.id === action.memoryId);
    if (!existing) {
      logger.warn('Cannot merge: memory not found', { memoryId: action.memoryId });
      return;
    }

    // 更新 memory 数据
    existing.evidence = [...new Set([...existing.evidence, ...action.newEvidence])];
    existing.confidence = Math.min(1, existing.evidence.length * 0.2);
    if (action.updatedContent) {
      existing.content = action.updatedContent;
    }
    existing.version++;
    existing.updatedAt = new Date().toISOString();

    // 通过 KnowledgeStore 更新（查找对应的 knowledge entry）
    const knEntries = this.knowledgeStore.list('memory');
    for (const meta of knEntries) {
      const full = this.knowledgeStore.get(meta.id);
      if (!full) continue;
      try {
        const parsed = JSON.parse(full.content) as MemoryEntry;
        if (parsed.id === action.memoryId) {
          this.knowledgeStore.update(meta.id, {
            content: JSON.stringify(existing),
          });
          break;
        }
      } catch {
        /* skip */
      }
    }

    this.versionStore.append({
      entryId: existing.id,
      version: existing.version,
      content: existing.content,
      action: 'merged',
      reason: `Merged ${action.newEvidence.length} new evidence(s)`,
      timestamp: new Date().toISOString(),
    });

    logger.info('Merged memory', { id: existing.id, newEvidence: action.newEvidence.length });
  }

  /** 用新 memory 替代旧 memory */
  private supersedeMemory(
    action: Extract<MemoryDistillAction, { type: 'SUPERSEDE' }>,
    existingMemories: MemoryEntry[],
  ): void {
    const oldMemory = existingMemories.find((m) => m.id === action.oldMemoryId);

    // 记录旧版本
    if (oldMemory) {
      this.versionStore.append({
        entryId: oldMemory.id,
        version: oldMemory.version,
        content: oldMemory.content,
        action: 'superseded',
        reason: 'Superseded by new memory',
        timestamp: new Date().toISOString(),
      });
    }

    // 创建新 memory
    const newMemory: MemoryEntry = {
      id: randomUUID(),
      theme: action.theme,
      title: action.title,
      content: action.content,
      evidence: action.diaryIds,
      confidence: Math.min(1, action.diaryIds.length * 0.2),
      version: 1,
      supersedes: action.oldMemoryId,
      promotedToRule: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.knowledgeStore.create({
      type: 'memory',
      title: action.title,
      content: JSON.stringify(newMemory),
      tags: [action.theme, 'supersedes:' + action.oldMemoryId],
    });

    this.versionStore.append({
      entryId: newMemory.id,
      version: 1,
      content: action.content,
      action: 'created',
      reason: `Supersedes ${action.oldMemoryId}`,
      timestamp: new Date().toISOString(),
    });

    logger.info('Superseded memory', {
      oldId: action.oldMemoryId,
      newId: newMemory.id,
      theme: action.theme,
    });
  }
}
