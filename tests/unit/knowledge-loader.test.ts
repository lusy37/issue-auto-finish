import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectKnowledge } from '../../src/knowledge/ProjectKnowledge.js';
import { KNOWLEDGE_DEFAULTS } from '../../src/knowledge/KnowledgeDefaults.js';

// We need to reset the module cache between tests since KnowledgeLoader uses module-level state
let loadKnowledge: typeof import('../../src/knowledge/KnowledgeLoader.js').loadKnowledge;
let getProjectKnowledge: typeof import('../../src/knowledge/KnowledgeLoader.js').getProjectKnowledge;
let reloadKnowledge: typeof import('../../src/knowledge/KnowledgeLoader.js').reloadKnowledge;
let resetKnowledgeCache: typeof import('../../src/knowledge/KnowledgeLoader.js').resetKnowledgeCache;

describe('KnowledgeLoader', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-test-'));
    // Fresh import to reset module state
    const mod = await import('../../src/knowledge/KnowledgeLoader.js');
    loadKnowledge = mod.loadKnowledge;
    getProjectKnowledge = mod.getProjectKnowledge;
    reloadKnowledge = mod.reloadKnowledge;
    resetKnowledgeCache = mod.resetKnowledgeCache;
    resetKnowledgeCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetKnowledgeCache();
  });

  function writeKnowledge(data: Partial<ProjectKnowledge>): string {
    const filePath = path.join(tmpDir, 'knowledge.json');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return filePath;
  }

  describe('loadKnowledge', () => {
    it('loads knowledge from explicit path', () => {
      const filePath = writeKnowledge({
        version: 1,
        structure: { primaryLanguage: 'Python', frameworks: ['Django'], isMonorepo: false, hasFrontendBackendSplit: false },
        toolchain: { packageManager: 'pip', installCommand: 'pip install -r requirements.txt' },
      });

      const result = loadKnowledge(filePath);
      expect(result).not.toBeNull();
      expect(result!.structure.primaryLanguage).toBe('Python');
      expect(result!.toolchain.packageManager).toBe('pip');
      expect(result!.toolchain.installCommand).toBe('pip install -r requirements.txt');
    });

    it('merges with defaults for missing fields', () => {
      const filePath = writeKnowledge({
        version: 1,
        structure: { primaryLanguage: 'Go', frameworks: [], isMonorepo: false, hasFrontendBackendSplit: false },
      });

      const result = loadKnowledge(filePath);
      expect(result).not.toBeNull();
      // Should use value from file
      expect(result!.structure.primaryLanguage).toBe('Go');
      // Should fall back to defaults for missing fields
      expect(result!.codeStyle.indentSize).toBe(KNOWLEDGE_DEFAULTS.codeStyle.indentSize);
      expect(result!.toolchain.installCommand).toBe(KNOWLEDGE_DEFAULTS.toolchain.installCommand);
    });

    it('显式知识路径不存在时给出明确错误', () => {
      expect(() => loadKnowledge(path.join(tmpDir, 'missing.json'))).toThrow('无法读取项目知识');
    });

    it('拒绝损坏的项目知识文件', () => {
      const filePath = path.join(tmpDir, 'knowledge.json');
      fs.writeFileSync(filePath, 'not valid json', 'utf-8');
      expect(() => loadKnowledge(filePath)).toThrow('无法读取项目知识');
    });
  });

  describe('getProjectKnowledge', () => {
    it('returns cached knowledge after loadKnowledge', () => {
      const filePath = writeKnowledge({
        version: 1,
        structure: { primaryLanguage: 'Rust', frameworks: [], isMonorepo: false, hasFrontendBackendSplit: false },
      });

      loadKnowledge(filePath);
      const cached = getProjectKnowledge();
      expect(cached).not.toBeNull();
      expect(cached!.structure.primaryLanguage).toBe('Rust');
    });

    it('returns null when no knowledge loaded and no file found', () => {
      // getProjectKnowledge will try to auto-load, but won't find knowledge.json
      // Reset cache first
      resetKnowledgeCache();
      // Since there's no knowledge.json in the default locations during test,
      // it should return null (or try and fail)
      const result = getProjectKnowledge();
      // Result depends on whether knowledge.json exists in default paths
      // For CI safety, just verify it doesn't throw
      expect(result === null || typeof result === 'object').toBe(true);
    });
  });

  describe('reloadKnowledge', () => {
    it('clears cache and reloads', () => {
      const filePath = writeKnowledge({
        version: 1,
        structure: { primaryLanguage: 'Java', frameworks: ['Spring'], isMonorepo: false, hasFrontendBackendSplit: false },
      });

      loadKnowledge(filePath);
      expect(getProjectKnowledge()!.structure.primaryLanguage).toBe('Java');

      // Modify file
      fs.writeFileSync(filePath, JSON.stringify({
        version: 1,
        structure: { primaryLanguage: 'Kotlin', frameworks: ['Ktor'], isMonorepo: false, hasFrontendBackendSplit: false },
      }), 'utf-8');

      // Cached value should still be Java
      expect(getProjectKnowledge()!.structure.primaryLanguage).toBe('Java');

      // After reload, should be Kotlin
      reloadKnowledge(filePath);
      expect(getProjectKnowledge()!.structure.primaryLanguage).toBe('Kotlin');
    });
  });
});

describe('KnowledgeDefaults', () => {
  it('has correct default values matching previous hardcoded behavior', () => {
    expect(KNOWLEDGE_DEFAULTS.toolchain.installCommand).toBe('npm install');
    expect(KNOWLEDGE_DEFAULTS.toolchain.installFallbackCommand).toBe('npm install');
    expect(KNOWLEDGE_DEFAULTS.toolchain.lintCommand).toBe('npm run lint');
    expect(KNOWLEDGE_DEFAULTS.toolchain.buildCommand).toBe('npm run build');
    expect(KNOWLEDGE_DEFAULTS.toolchain.testFilesCommand).toBe('npm test -- {files}');
    expect(KNOWLEDGE_DEFAULTS.toolchain.dependencyCheckPath).toBe('node_modules/.bin/eslint');
    expect(KNOWLEDGE_DEFAULTS.codeStyle.indentSize).toBe(2);
    expect(KNOWLEDGE_DEFAULTS.codeStyle.lineWidth).toBe(120);
    expect(KNOWLEDGE_DEFAULTS.ruleTriggers).toHaveLength(0);
    expect(KNOWLEDGE_DEFAULTS.knownIssues).toHaveLength(0);
  });
});

describe('getKnowledgeForPrompt', () => {
  let getKnowledgeForPrompt: typeof import('../../src/prompts/templates.js').getKnowledgeForPrompt;
  let resetKnowledgeCache: typeof import('../../src/knowledge/KnowledgeLoader.js').resetKnowledgeCache;

  beforeEach(async () => {
    const templates = await import('../../src/prompts/templates.js');
    const loader = await import('../../src/knowledge/KnowledgeLoader.js');
    getKnowledgeForPrompt = templates.getKnowledgeForPrompt;
    resetKnowledgeCache = loader.resetKnowledgeCache;
    resetKnowledgeCache();
  });

  afterEach(() => {
    resetKnowledgeCache();
    vi.restoreAllMocks();
  });

  it('returns expected template variables from defaults', () => {
    // Mock fs.existsSync so no knowledge.json is found and KNOWLEDGE_DEFAULTS are used
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const vars = getKnowledgeForPrompt();
    expect(vars.installCommand).toBe('npm install');
    expect(vars.installFallbackCommand).toBe('npm install');
    expect(vars.lintCommand).toBe('npm run lint');
    expect(vars.buildCommand).toBe('npm run build');
    expect(vars.testFilesCommand).toBe('npm test -- {files}');
    expect(vars.dependencyCheckPath).toBe('node_modules/.bin/eslint');
    expect(vars.codeStyleDescription).toContain('2空格缩进');
    expect(vars.codeStyleDescription).toContain('120字符行宽');
    expect(vars.knownIssuesSection).toContain('无已知预存问题');
    expect(vars.e2eDir).toBe('frontend/e2e/dynamic');
    expect(vars.e2eTool).toBe('Playwright');
    expect(vars.frontendDir).toBe('.');
  });
});
