import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeJsonAtomicSync, writeTextAtomicSync } from '../utils/atomicFile.js';
import { logger as rootLogger } from '../logger.js';
import type {
  KnowledgeEntry,
  KnowledgeEntryMeta,
  KnowledgeEntryType,
  KnowledgeIndex,
  KnowledgeStats,
} from './KnowledgeEntry.js';
import type { ProjectKnowledge } from './ProjectKnowledge.js';

const logger = rootLogger.child('KnowledgeStore');

const indexSchema = z
  .object({
    version: z.literal(1),
    lastAnalyzedAt: z.string().optional(),
    entries: z.array(
      z
        .object({
          id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
          type: z.enum(['project-meta', 'custom', 'diary', 'memory', 'agent-rule']),
          title: z.string(),
          tags: z.array(z.string()),
          source: z
            .object({ url: z.string().optional(), kind: z.literal('local').optional() })
            .passthrough()
            .optional(),
          createdAt: z.string(),
          updatedAt: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export class KnowledgeStore {
  private dataDir: string;
  private indexPath: string;
  private entriesDir: string;
  private index: KnowledgeIndex | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.indexPath = path.join(dataDir, 'index.json');
    this.entriesDir = path.join(dataDir, 'entries');
  }

  list(type?: KnowledgeEntryType): KnowledgeEntryMeta[] {
    const idx = this.loadIndex();
    return structuredClone(type ? idx.entries.filter((e) => e.type === type) : idx.entries);
  }

  get(id: string): KnowledgeEntry | null {
    const idx = this.loadIndex();
    const meta = idx.entries.find((e) => e.id === id);
    if (!meta) return null;
    return { ...structuredClone(meta), content: this.readContent(id) };
  }

  create(input: {
    id?: string;
    type: KnowledgeEntryType;
    title: string;
    content: string;
    tags?: string[];
    source?: KnowledgeEntry['source'];
  }): KnowledgeEntry {
    this.ensureDirs();
    const idx = structuredClone(this.loadIndex());

    const id = input.id ?? randomUUID();
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || idx.entries.some((entry) => entry.id === id)) {
      throw new Error(`知识条目 ID 无效或已存在：${id}`);
    }
    const entry: KnowledgeEntry = {
      id,
      type: input.type,
      title: input.title,
      content: input.content,
      tags: input.tags ?? [],
      source: input.source,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.writeContent(entry.id, entry.content);
    idx.entries.push(this.toMeta(entry));
    this.saveIndex(idx);

    logger.info('Knowledge entry created', { id: entry.id, type: entry.type, title: entry.title });
    return entry;
  }

  update(
    id: string,
    patch: Partial<Pick<KnowledgeEntry, 'title' | 'content' | 'tags' | 'source'>>,
  ): KnowledgeEntry | null {
    const idx = structuredClone(this.loadIndex());
    const metaIdx = idx.entries.findIndex((e) => e.id === id);
    if (metaIdx < 0) return null;

    const meta = idx.entries[metaIdx];
    if (patch.title !== undefined) meta.title = patch.title;
    if (patch.tags !== undefined) meta.tags = patch.tags;
    if (patch.source !== undefined) meta.source = patch.source;
    meta.updatedAt = new Date().toISOString();

    if (patch.content !== undefined) {
      this.writeContent(id, patch.content);
    }

    idx.entries[metaIdx] = meta;
    this.saveIndex(idx);

    const content = patch.content ?? this.readContent(id);
    logger.info('Knowledge entry updated', { id, title: meta.title });
    return { ...meta, content };
  }

  delete(id: string): boolean {
    const idx = structuredClone(this.loadIndex());
    const before = idx.entries.length;
    idx.entries = idx.entries.filter((e) => e.id !== id);
    if (idx.entries.length === before) return false;

    this.saveIndex(idx);
    const filePath = path.join(this.entriesDir, id + '.md');
    try {
      fs.rmSync(filePath, { force: true });
    } catch (error) {
      // 索引已提交，保留删除结果；正文残留可按日志定位后清理。
      logger.warn('知识已删除，但正文清理失败', { id, filePath, error: (error as Error).message });
    }
    logger.info('Knowledge entry deleted', { id });
    return true;
  }

  search(query: string): KnowledgeEntryMeta[] {
    const idx = this.loadIndex();
    const lower = query.toLowerCase();
    return structuredClone(
      idx.entries.filter(
        (e) =>
          e.title.toLowerCase().includes(lower) ||
          e.tags.some((t) => t.toLowerCase().includes(lower)),
      ),
    );
  }

  getProjectMeta(): KnowledgeEntry | null {
    const idx = this.loadIndex();
    const meta = idx.entries.find((e) => e.type === 'project-meta');
    if (!meta) return null;
    return { ...structuredClone(meta), content: this.readContent(meta.id) };
  }

  upsertProjectMeta(content: string, knowledge?: ProjectKnowledge): KnowledgeEntry {
    const existing = this.getProjectMeta();
    if (existing) {
      return this.update(existing.id, { content, title: '项目分析' })!;
    }
    return this.create({
      type: 'project-meta',
      title: '项目分析',
      content,
      tags: knowledge
        ? [knowledge.structure.primaryLanguage, ...knowledge.structure.frameworks]
        : [],
    });
  }

  setLastAnalyzedAt(time: string): void {
    const idx = structuredClone(this.loadIndex());
    idx.lastAnalyzedAt = time;
    this.saveIndex(idx);
  }

  getStats(): KnowledgeStats {
    const idx = this.loadIndex();
    const byType: Record<KnowledgeEntryType, number> = {
      'project-meta': 0,
      custom: 0,
      diary: 0,
      memory: 0,
      'agent-rule': 0,
    };
    for (const e of idx.entries) {
      byType[e.type] = (byType[e.type] || 0) + 1;
    }
    return {
      total: idx.entries.length,
      byType,
      lastAnalyzedAt: idx.lastAnalyzedAt,
    };
  }

  getAllEntries(): KnowledgeEntry[] {
    const idx = this.loadIndex();
    return idx.entries.map((meta) => ({
      ...structuredClone(meta),
      content: this.readContent(meta.id),
    }));
  }

  private ensureDirs(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    if (!fs.existsSync(this.entriesDir)) {
      fs.mkdirSync(this.entriesDir, { recursive: true });
    }
  }

  private loadIndex(): KnowledgeIndex {
    if (this.index) return this.index;

    this.ensureDirs();
    try {
      const raw = fs.readFileSync(this.indexPath, 'utf-8');
      this.index = indexSchema.parse(JSON.parse(raw));
      return this.index;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`无法读取知识索引 ${this.indexPath}：${(error as Error).message}`, {
          cause: error,
        });
      }
      if (fs.readdirSync(this.entriesDir).some((file) => file.endsWith('.md'))) {
        throw new Error(`知识索引缺失但正文仍存在，请恢复索引：${this.indexPath}`);
      }
    }

    this.index = { version: 1, entries: [] };
    return this.index;
  }

  private saveIndex(idx: KnowledgeIndex): void {
    this.ensureDirs();
    writeJsonAtomicSync(this.indexPath, idx);
    this.index = structuredClone(idx);
  }

  private readContent(id: string): string {
    const filePath = path.join(this.entriesDir, id + '.md');
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      throw new Error(`无法读取知识正文 ${filePath}：${(error as Error).message}`, {
        cause: error,
      });
    }
  }

  private writeContent(id: string, content: string): void {
    this.ensureDirs();
    writeTextAtomicSync(path.join(this.entriesDir, id + '.md'), content);
  }

  private toMeta(entry: KnowledgeEntry): KnowledgeEntryMeta {
    const { content: _content, ...meta } = entry;
    return meta;
  }
}

export function projectKnowledgeToMarkdown(k: ProjectKnowledge): string {
  const lines: string[] = ['# 项目分析报告', ''];
  lines.push('> 生成时间: ' + k.generatedAt);
  if (k.repoPath) lines.push('> 项目路径: ' + k.repoPath);
  lines.push('');

  // Business context (placed first for readability)
  if (k.businessContext?.purpose) {
    lines.push('## 业务上下文');
    lines.push('- 项目目的: ' + k.businessContext.purpose);
    if (k.businessContext.targetUsers) lines.push('- 目标用户: ' + k.businessContext.targetUsers);
    if (k.businessContext.domain) lines.push('- 业务领域: ' + k.businessContext.domain);
    if (k.businessContext.coreFeatures?.length) {
      lines.push('- 核心功能:');
      for (const feat of k.businessContext.coreFeatures) {
        lines.push('  - ' + feat);
      }
    }
    lines.push('');
  }

  // Architecture
  if (k.architecture?.overview) {
    lines.push('## 架构');
    lines.push('');
    lines.push(k.architecture.overview);
    lines.push('');

    if (k.architecture.keyModules?.length) {
      lines.push('### 关键模块');
      for (const mod of k.architecture.keyModules) {
        lines.push('- **' + mod.name + '** (`' + mod.path + '`): ' + mod.responsibility);
      }
      lines.push('');
    }

    if (k.architecture.dataFlow) {
      lines.push('### 核心数据流');
      lines.push('');
      lines.push(k.architecture.dataFlow);
      lines.push('');
    }

    if (k.architecture.designPatterns?.length) {
      lines.push('### 设计模式');
      lines.push(k.architecture.designPatterns.join(', '));
      lines.push('');
    }

    if (k.architecture.externalDependencies?.length) {
      lines.push('### 外部依赖');
      for (const dep of k.architecture.externalDependencies) {
        lines.push('- ' + dep);
      }
      lines.push('');
    }
  }

  // Domain concepts
  if (k.domainConcepts?.length) {
    lines.push('## 领域概念');
    for (const concept of k.domainConcepts) {
      lines.push('- **' + concept.term + '**: ' + concept.definition);
    }
    lines.push('');
  }

  lines.push('## 项目结构');
  lines.push('- 主要语言: ' + k.structure.primaryLanguage);
  if (k.structure.frameworks.length) lines.push('- 框架: ' + k.structure.frameworks.join(', '));
  if (k.structure.description) lines.push('- 描述: ' + k.structure.description);
  lines.push('- Monorepo: ' + (k.structure.isMonorepo ? '是' : '否'));
  if (k.structure.frontendDir) lines.push('- 前端目录: ' + k.structure.frontendDir);
  if (k.structure.e2eDir) lines.push('- E2E 目录: ' + k.structure.e2eDir);
  if (k.structure.e2eTool) lines.push('- E2E 工具: ' + k.structure.e2eTool);
  lines.push('');

  lines.push('## 工具链');
  lines.push('- 包管理器: ' + k.toolchain.packageManager);
  lines.push('- 安装命令: `' + k.toolchain.installCommand + '`');
  if (k.toolchain.lintCommand) lines.push('- Lint: `' + k.toolchain.lintCommand + '`');
  if (k.toolchain.buildCommand) lines.push('- Build: `' + k.toolchain.buildCommand + '`');
  if (k.toolchain.testCommand) lines.push('- Test: `' + k.toolchain.testCommand + '`');
  lines.push('');

  lines.push('## 代码风格');
  lines.push('- 缩进: ' + k.codeStyle.indentSize + ' ' + k.codeStyle.indentStyle);
  lines.push('- 行宽: ' + k.codeStyle.lineWidth);
  if (k.codeStyle.additionalRules?.length) {
    for (const rule of k.codeStyle.additionalRules) {
      lines.push('- ' + rule);
    }
  }
  lines.push('');

  // Agent knowledge
  if (k.agentKnowledge?.summary) {
    lines.push('## Agent 知识沉淀');
    lines.push('');
    lines.push(k.agentKnowledge.summary);
    lines.push('');

    if (k.agentKnowledge.rules?.length) {
      lines.push('### 本地规则');
      for (const rule of k.agentKnowledge.rules) {
        lines.push('- **' + rule.filename + '**: ' + rule.purpose);
        if (rule.keyPoints?.length) {
          for (const point of rule.keyPoints) {
            lines.push('  - ' + point);
          }
        }
      }
      lines.push('');
    }

    if (k.agentKnowledge.claudeMdSummary) {
      lines.push('### CLAUDE.md 摘要');
      lines.push('');
      lines.push(k.agentKnowledge.claudeMdSummary);
      lines.push('');
    }

    if (k.agentKnowledge.conventions?.length) {
      lines.push('### 开发约定');
      for (const conv of k.agentKnowledge.conventions) {
        lines.push('- ' + conv);
      }
      lines.push('');
    }
  }

  if (k.knownIssues?.length) {
    lines.push('## 已知问题');
    for (const issue of k.knownIssues) {
      const pattern = issue.pattern ? ' (匹配: `' + issue.pattern + '`)' : '';
      lines.push('- **' + issue.description + '**' + pattern);
      lines.push('  建议: ' + issue.advice);
    }
    lines.push('');
  }

  return lines.join('\n');
}
