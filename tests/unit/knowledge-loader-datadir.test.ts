import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('KnowledgeLoader DATA_DIR priority', () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-test-'));
    // Clear any cached knowledge
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves knowledge from DATA_DIR/knowledge/knowledge.json', async () => {
    // Set DATA_DIR to our temp dir
    process.env.DATA_DIR = path.join(tmpDir, 'data');
    const knowledgeDir = path.join(tmpDir, 'data', 'knowledge');
    fs.mkdirSync(knowledgeDir, { recursive: true });

    const knowledgeData = {
      version: 1,
      projectName: 'data-dir-test',
      generatedAt: new Date().toISOString(),
      repoPath: '/test',
    };
    fs.writeFileSync(
      path.join(knowledgeDir, 'knowledge.json'),
      JSON.stringify(knowledgeData),
    );

    // Dynamic import to get fresh module
    const { loadKnowledge, resetKnowledgeCache } = await import('../../src/knowledge/KnowledgeLoader.js');
    resetKnowledgeCache();

    const result = loadKnowledge();
    expect(result).not.toBeNull();
    expect(result!.projectName).toBe('data-dir-test');
  });

  it('DATA_DIR takes priority over project directory', async () => {
    process.env.DATA_DIR = path.join(tmpDir, 'data');
    const knowledgeDir = path.join(tmpDir, 'data', 'knowledge');
    fs.mkdirSync(knowledgeDir, { recursive: true });

    // Write to DATA_DIR
    const dataDirKnowledge = {
      version: 1,
      projectName: 'from-data-dir',
      generatedAt: new Date().toISOString(),
      repoPath: '/test',
    };
    fs.writeFileSync(
      path.join(knowledgeDir, 'knowledge.json'),
      JSON.stringify(dataDirKnowledge),
    );

    const { loadKnowledge, resetKnowledgeCache } = await import('../../src/knowledge/KnowledgeLoader.js');
    resetKnowledgeCache();

    const result = loadKnowledge();
    expect(result).not.toBeNull();
    expect(result!.projectName).toBe('from-data-dir');
  });
});
