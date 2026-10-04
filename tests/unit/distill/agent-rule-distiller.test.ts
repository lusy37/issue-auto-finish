import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentRuleDistiller } from '../../../src/distill/AgentRuleDistiller.js';
import { VersionStore } from '../../../src/distill/VersionStore.js';
import { KnowledgeStore } from '../../../src/knowledge/KnowledgeStore.js';
import type { MemoryEntry } from '../../../src/distill/types.js';
import type { AIRunner } from '../../../src/ai-runner/AIRunner.js';

function makeMockAIRunner(output: string, success = true): AIRunner {
  return {
    run: vi.fn().mockResolvedValue({
      success,
      output,
      exitCode: success ? 0 : 1,
    }),
    killAll: vi.fn(),
    killByWorkDir: vi.fn(),
  };
}

function createMatureMemory(knowledgeStore: KnowledgeStore, id: string): void {
  const memory: MemoryEntry = {
    id,
    theme: 'failure-pattern',
    title: 'Test Memory',
    content: 'Memory content about failures',
    evidence: ['d1', 'd2', 'd3', 'd4'],
    confidence: 0.8,
    version: 1,
    promotedToRule: false,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };

  knowledgeStore.create({
    id,
    type: 'memory',
    title: memory.title,
    content: JSON.stringify(memory),
    tags: [memory.theme],
  });
}

describe('AgentRuleDistiller', () => {
  let tmpDir: string;
  let knowledgeStore: KnowledgeStore;
  let versionStore: VersionStore;
  let rulesDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-distiller-'));
    const knDir = path.join(tmpDir, 'knowledge');
    rulesDir = path.join(tmpDir, 'rules');
    fs.mkdirSync(knDir, { recursive: true });
    fs.mkdirSync(rulesDir, { recursive: true });
    knowledgeStore = new KnowledgeStore(knDir);
    versionStore = new VersionStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips when no mature memories', async () => {
    const distiller = new AgentRuleDistiller({
      aiRunner: makeMockAIRunner(''),
      knowledgeStore,
      versionStore,
      workDir: tmpDir,
      aiPolicy: { timeoutMs: 10000, idleTimeoutMs: 4567, timeoutGraceMs: 123, timeoutExtensionMs: 789, timeoutMaxExtensions: 2, model: 'test-model' },
      confidenceThreshold: 0.7,
      rulesDir,
    });

    const result = await distiller.distill();
    expect(result.processedMemories).toBe(0);
    expect(result.actions).toBe(0);
  });

  it('creates Markdown rule from mature memory', async () => {
    createMatureMemory(knowledgeStore, 'mem-1');

    const aiOutput = JSON.stringify({
      actions: [
        {
          type: 'CREATE',
          ruleName: 'handle-pnpm-failures',
          title: '处理 pnpm 安装失败',
          content: '当 pnpm install 失败时，尝试以下步骤...',
          keywords: ['pnpm', 'install', 'failure'],
          alwaysApply: false,
          sourceMemoryIds: ['mem-1'],
        },
      ],
    });

    const runner = makeMockAIRunner('```json\n' + aiOutput + '\n```');
    const distiller = new AgentRuleDistiller({
      aiRunner: runner,
      knowledgeStore,
      versionStore,
      workDir: tmpDir,
      aiPolicy: { timeoutMs: 10000, idleTimeoutMs: 4567, timeoutGraceMs: 123, timeoutExtensionMs: 789, timeoutMaxExtensions: 2, model: 'test-model' },
      confidenceThreshold: 0.7,
      rulesDir,
    });

    const result = await distiller.distill();
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({ mode: 'plan', timeoutMs: 10000, idleTimeoutMs: 4567, timeoutGraceMs: 123, timeoutExtensionMs: 789, timeoutMaxExtensions: 2, model: 'test-model' }));
    expect(result.actions).toBe(1);

    // Check MDC file created
    const mdcFile = path.join(rulesDir, fs.readdirSync(rulesDir).find(name => name.endsWith('.md'))!);
    expect(fs.existsSync(mdcFile)).toBe(true);

    const content = fs.readFileSync(mdcFile, 'utf-8');
    expect(content).toContain('# 处理 pnpm 安装失败');
    expect(content).not.toContain('alwaysApply:');

    // Check rule stored in knowledge store
    const rules = knowledgeStore.list('agent-rule');
    expect(rules).toHaveLength(1);
  });

  it('handles AI failure gracefully', async () => {
    createMatureMemory(knowledgeStore, 'mem-1');

    const distiller = new AgentRuleDistiller({
      aiRunner: makeMockAIRunner('Error', false),
      knowledgeStore,
      versionStore,
      workDir: tmpDir,
      aiPolicy: { timeoutMs: 10000, idleTimeoutMs: 4567, timeoutGraceMs: 123, timeoutExtensionMs: 789, timeoutMaxExtensions: 2, model: 'test-model' },
      confidenceThreshold: 0.7,
      rulesDir,
    });

    await expect(distiller.distill()).rejects.toThrow('Rule distillation AI call failed');
  });

  it('filters out low-confidence memories', async () => {
    // Create a low-confidence memory
    const memory: MemoryEntry = {
      id: 'low-conf',
      theme: 'failure-pattern',
      title: 'Low Confidence',
      content: 'Not enough evidence',
      evidence: ['d1'],
      confidence: 0.2,
      version: 1,
      promotedToRule: false,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    };
    knowledgeStore.create({
      id: memory.id,
      type: 'memory',
      title: memory.title,
      content: JSON.stringify(memory),
      tags: [memory.theme],
    });

    const distiller = new AgentRuleDistiller({
      aiRunner: makeMockAIRunner(''),
      knowledgeStore,
      versionStore,
      workDir: tmpDir,
      aiPolicy: { timeoutMs: 10000, idleTimeoutMs: 4567, timeoutGraceMs: 123, timeoutExtensionMs: 789, timeoutMaxExtensions: 2, model: 'test-model' },
      confidenceThreshold: 0.7,
      rulesDir,
    });

    const result = await distiller.distill();
    expect(result.processedMemories).toBe(0);
  });
});
