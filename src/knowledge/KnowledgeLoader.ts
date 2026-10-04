import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { writeJsonAtomicSync } from '../utils/atomicFile.js';
import { logger as rootLogger } from '../logger.js';
import type { ProjectKnowledge } from './ProjectKnowledge.js';
import { resolveDataDir } from '../paths.js';

const logger = rootLogger.child('KnowledgeLoader');

let _cachedKnowledge: ProjectKnowledge | null | undefined;
let activeSource: { file: string; explicit: boolean } | undefined;

function resolveSource(explicitPath?: string) {
  return explicitPath !== undefined
    ? { file: path.resolve(explicitPath), explicit: true }
    : (activeSource ?? {
        file: path.join(resolveDataDir(), 'knowledge', 'knowledge.json'),
        explicit: false,
      });
}

const strings = z.array(z.string());
const knowledgeSchema = z
  .object({
    version: z.literal(1),
    generatedAt: z.string(),
    repoPath: z.string(),
    structure: z
      .object({
        primaryLanguage: z.string(),
        frameworks: strings,
        isMonorepo: z.boolean(),
        hasFrontendBackendSplit: z.boolean(),
        frontendDir: z.string().optional(),
        e2eDir: z.string().optional(),
        e2eTool: z.string().optional(),
        description: z.string().optional(),
      }),
    toolchain: z
      .object({
        packageManager: z.string(),
        installCommand: z.string(),
        installFallbackCommand: z.string().optional(),
        lintCommand: z.string().optional(),
        buildCommand: z.string().optional(),
        testCommand: z.string().optional(),
        testFilesCommand: z.string().optional(),
        dependencyCheckPath: z.string().optional(),
      }),
    codeStyle: z
      .object({
        indentStyle: z.enum(['spaces', 'tabs']),
        indentSize: z.number(),
        lineWidth: z.number(),
        additionalRules: strings.optional(),
      }),
    businessContext: z
      .object({
        purpose: z.string(),
        targetUsers: z.string(),
        domain: z.string(),
        coreFeatures: strings,
      }),
    architecture: z
      .object({
        overview: z.string(),
        dataFlow: z.string(),
        designPatterns: strings,
        externalDependencies: strings,
        keyModules: z.array(
          z
            .object({ name: z.string(), path: z.string(), responsibility: z.string() }),
        ),
      }),
  domainConcepts: z.array(z.object({ term: z.string(), definition: z.string() })),
    agentKnowledge: z
      .object({
        summary: z.string(),
        conventions: strings,
        claudeMdSummary: z.string().optional(),
        rules: z.array(
          z.object({ filename: z.string(), purpose: z.string(), keyPoints: strings }),
        ),
      }),
    ruleTriggers: z.array(
      z.object({ filename: z.string(), keywords: strings, description: z.string().optional() }),
    ),
    knownIssues: z.array(
      z.object({ description: z.string(), pattern: z.string().optional(), advice: z.string() }),
    ),
    custom: z.record(z.string(), z.unknown()).optional(),
  });

/**
 * 加载同一来源的完整项目知识；文件存在但结构不完整时直接失败。
 */
export function loadKnowledge(explicitPath?: string): ProjectKnowledge | null {
  const source = resolveSource(explicitPath);
  const filePath = source.file;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = knowledgeSchema.parse(JSON.parse(raw)) as ProjectKnowledge;
    if (parsed.version !== 1) throw new Error('不支持的项目知识格式，只支持当前 version=1');
    const merged = parsed;
    activeSource = source;
    _cachedKnowledge = merged;
    logger.info('Knowledge loaded', {
      path: filePath,
      version: merged.version,
    });
    return merged;
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).code === 'ENOENT' &&
      !source.explicit &&
      _cachedKnowledge == null
    ) {
      activeSource = source;
      _cachedKnowledge = null;
      return null;
    }
    logger.warn('无法读取项目知识', {
      path: filePath,
      error: (err as Error).message,
    });
    throw new Error(`无法读取项目知识 ${filePath}：${(err as Error).message}`, { cause: err });
  }
}

/** 资料与启动加载共用当前来源，成功落盘后才发布新的知识缓存。 */
export function saveKnowledge(knowledge: ProjectKnowledge): void {
  const checked = knowledgeSchema.parse(knowledge) as ProjectKnowledge;
  const source = resolveSource();
  fs.mkdirSync(path.dirname(source.file), { recursive: true });
  writeJsonAtomicSync(source.file, checked);
  activeSource = source;
  _cachedKnowledge = checked;
}

/**
 * 获取最近成功加载的项目知识；全新默认目录可以没有资料。
 */
export function getProjectKnowledge(): ProjectKnowledge | null {
  if (_cachedKnowledge === undefined) {
    return loadKnowledge();
  }
  return _cachedKnowledge;
}

/**
 * 重新加载当前来源，失败时保留最近成功的缓存。
 */
export function reloadKnowledge(explicitPath?: string): ProjectKnowledge | null {
  return loadKnowledge(explicitPath);
}

/**
 * 重置缓存与来源，仅用于测试隔离。
 */
export function resetKnowledgeCache(): void {
  _cachedKnowledge = undefined;
  activeSource = undefined;
}
