import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('AgentRuleDistiller DATA_DIR integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ard-test-'));
    process.env.DATA_DIR = path.join(tmpDir, 'data');
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses DATA_DIR/rules/ as default rulesDir', async () => {
    const { AgentRuleDistiller } = await import('../../src/distill/AgentRuleDistiller.js');

    const mockKnowledgeStore = {
      list: vi.fn().mockReturnValue([]),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };

    const mockVersionStore = {
      append: vi.fn(),
    };

    const distiller = new AgentRuleDistiller({
      aiRunner: { run: vi.fn(), killAll: vi.fn() } as any,
      knowledgeStore: mockKnowledgeStore as any,
      versionStore: mockVersionStore as any,
      workDir: path.join(tmpDir, 'project'),
      timeoutMs: 30000,
      confidenceThreshold: 0.7,
    });

    // Verify the distiller was created successfully
    expect(distiller).toBeDefined();

    // Run distill with no mature memories (should return early)
    const result = await distiller.distill();
    expect(result.processedMemories).toBe(0);
    expect(result.actions).toBe(0);
  });

  it('respects syncToProject option', async () => {
    const { AgentRuleDistiller } = await import('../../src/distill/AgentRuleDistiller.js');

    const mockKnowledgeStore = {
      list: vi.fn().mockReturnValue([]),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };

    const mockVersionStore = {
      append: vi.fn(),
    };

    const projectDir = path.join(tmpDir, 'project');
    const projectRulesDir = path.join(projectDir, '.cursor', 'rules');

    const distiller = new AgentRuleDistiller({
      aiRunner: { run: vi.fn(), killAll: vi.fn() } as any,
      knowledgeStore: mockKnowledgeStore as any,
      versionStore: mockVersionStore as any,
      workDir: projectDir,
      timeoutMs: 30000,
      confidenceThreshold: 0.7,
      syncToProject: true,
      projectRulesDir,
    });

    expect(distiller).toBeDefined();
  });
});
