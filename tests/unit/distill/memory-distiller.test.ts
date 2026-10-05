import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryDistiller } from '../../../src/distill/MemoryDistiller.js';
import { DiaryStore } from '../../../src/distill/DiaryStore.js';
import { VersionStore } from '../../../src/distill/VersionStore.js';
import { KnowledgeStore } from '../../../src/knowledge/KnowledgeStore.js';
import type { DiaryEntry, MemoryEntry } from '../../../src/distill/types.js';
import type { AIRunner } from '../../../src/ai-runner/AIRunner.js';

function makeDiary(id: string, outcome: 'completed' | 'failed' = 'completed'): DiaryEntry {
  return {
    id,
    issueIid: 42,
    issueTitle: 'Test Issue',
    branchName: 'feat/issue-42',
    pipelineMode: 'classic',
    outcome,
    timing: {
      totalDurationMs: 60000,
      phaseTimings: [],
      startedAt: '2025-01-01T00:00:00.000Z',
      finishedAt: '2025-01-01T00:01:00.000Z',
    },
    humanInterventions: [],
    artifactSummary: '测试摘要',
    distilled: false,
    createdAt: '2025-01-01T00:01:00.000Z',
  };
}

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

describe('MemoryDistiller', () => {
  let tmpDir: string;
  let diaryStore: DiaryStore;
  let knowledgeStore: KnowledgeStore;
  let versionStore: VersionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-distiller-'));
    const diaryDir = path.join(tmpDir, 'diaries');
    const knDir = path.join(tmpDir, 'knowledge');
    fs.mkdirSync(diaryDir, { recursive: true });
    fs.mkdirSync(knDir, { recursive: true });
    diaryStore = new DiaryStore(diaryDir);
    knowledgeStore = new KnowledgeStore(knDir);
    versionStore = new VersionStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips when insufficient diaries', async () => {
    diaryStore.create(makeDiary('d1'));

    const distiller = new MemoryDistiller({
      aiRunner: makeMockAIRunner(''),
      diaryStore,
      knowledgeStore,
      versionStore,
      workDir: tmpDir,
      aiPolicy: { timeoutMs: 10000, idleTimeoutMs: 4567, timeoutGraceMs: 123, timeoutExtensionMs: 789, timeoutMaxExtensions: 2, model: 'test-model' },
      minDiariesForDistill: 3,
    });

    const result = await distiller.distill();
    expect(result.processedDiaries).toBe(0);
    expect(result.actions).toBe(0);
  });

  it('processes diaries and creates memory from AI output', async () => {
    diaryStore.create(makeDiary('d1'));
    diaryStore.create(makeDiary('d2'));
    diaryStore.create(makeDiary('d3'));

    const aiOutput = JSON.stringify({
      actions: [
        {
          type: 'CREATE',
          theme: 'failure-pattern',
          title: 'pnpm install failures',
          content: 'Common failure pattern in CI',
          diaryIds: ['d1', 'd2'],
        },
      ],
    });

    const mockRunner = makeMockAIRunner('```json\n' + aiOutput + '\n```');

    const distiller = new MemoryDistiller({
      aiRunner: mockRunner,
      diaryStore,
      knowledgeStore,
      versionStore,
      workDir: tmpDir,
      aiPolicy: { timeoutMs: 10000, idleTimeoutMs: 4567, timeoutGraceMs: 123, timeoutExtensionMs: 789, timeoutMaxExtensions: 2, model: 'test-model' },
      minDiariesForDistill: 3,
    });

    const result = await distiller.distill();
    expect(mockRunner.run).toHaveBeenCalledWith(expect.objectContaining({ mode: 'plan', timeoutMs: 10000, idleTimeoutMs: 4567, timeoutGraceMs: 123, timeoutExtensionMs: 789, timeoutMaxExtensions: 2, model: 'test-model' }));
    expect(result.processedDiaries).toBe(3);
    expect(result.actions).toBe(1);

    // Verify memory was created in knowledge store
    const memories = knowledgeStore.list('memory');
    expect(memories).toHaveLength(1);
    expect(memories[0].title).toBe('pnpm install failures');

    // Verify diaries marked as distilled
    expect(diaryStore.undistilledCount()).toBe(0);

    // Verify version recorded
    expect(versionStore.count()).toBe(1);
  });

  it('handles AI failure gracefully', async () => {
    diaryStore.create(makeDiary('d1'));
    diaryStore.create(makeDiary('d2'));
    diaryStore.create(makeDiary('d3'));

    const mockRunner = makeMockAIRunner('Error occurred', false);

    const distiller = new MemoryDistiller({
      aiRunner: mockRunner,
      diaryStore,
      knowledgeStore,
      versionStore,
      workDir: tmpDir,
      aiPolicy: { timeoutMs: 10000, idleTimeoutMs: 4567, timeoutGraceMs: 123, timeoutExtensionMs: 789, timeoutMaxExtensions: 2, model: 'test-model' },
      minDiariesForDistill: 3,
    });

    await expect(distiller.distill()).rejects.toThrow('Memory distillation AI call failed');
  });

  it.each([true, false])('替代记忆保留关联、置信度与版本历史，旧条目存在=%s', async exists => {
    const old: MemoryEntry = {
      id: 'old-memory', theme: 'failure-pattern', title: '旧记忆', content: '旧经验',
      evidence: ['old-diary'], confidence: 0.2, version: 3, promotedToRule: false,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    if (exists) knowledgeStore.create({ id: old.id, type: 'memory', title: old.title, content: JSON.stringify(old) });
    diaryStore.create(makeDiary('d1'));
    const diaryIds = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
    const distiller = new MemoryDistiller({
      aiRunner: makeMockAIRunner(JSON.stringify({ actions: [{
        type: 'SUPERSEDE', oldMemoryId: old.id, theme: 'failure-pattern',
        title: '新记忆', content: '修订经验', diaryIds,
      }] })),
      diaryStore, knowledgeStore, versionStore, workDir: tmpDir,
      aiPolicy: { timeoutMs: 10000 }, minDiariesForDistill: 1,
    });
    expect(await distiller.distill()).toEqual({ processedDiaries: 1, actions: 1 });
    const created = knowledgeStore.getAllEntries().find(entry => entry.id !== old.id)!;
    expect(JSON.parse(created.content)).toMatchObject({
      supersedes: old.id, evidence: diaryIds, confidence: 1, version: 1,
      promotedToRule: false, content: '修订经验',
    });
    expect(created.tags).toEqual(['failure-pattern', 'supersedes:old-memory']);
    expect(versionStore.getByEntryId(created.id)).toEqual([expect.objectContaining({
      version: 1, action: 'created', content: '修订经验', reason: 'Supersedes old-memory',
    })]);
    expect(versionStore.getByEntryId(old.id)).toEqual(exists ? [expect.objectContaining({
      version: 3, action: 'superseded', content: '旧经验',
    })] : []);
    expect(knowledgeStore.get(old.id)?.content).toBe(exists ? JSON.stringify(old) : undefined);
  });

  it('marks diaries as distilled even with no actions', async () => {
    diaryStore.create(makeDiary('d1'));
    diaryStore.create(makeDiary('d2'));
    diaryStore.create(makeDiary('d3'));

    const mockRunner = makeMockAIRunner(JSON.stringify({ actions: [] }));

    const distiller = new MemoryDistiller({
      aiRunner: mockRunner,
      diaryStore,
      knowledgeStore,
      versionStore,
      workDir: tmpDir,
      aiPolicy: { timeoutMs: 10000, idleTimeoutMs: 4567, timeoutGraceMs: 123, timeoutExtensionMs: 789, timeoutMaxExtensions: 2, model: 'test-model' },
      minDiariesForDistill: 3,
    });

    const result = await distiller.distill();
    expect(mockRunner.run).toHaveBeenCalledWith(expect.objectContaining({ mode: 'plan', timeoutMs: 10000, idleTimeoutMs: 4567, timeoutGraceMs: 123, timeoutExtensionMs: 789, timeoutMaxExtensions: 2, model: 'test-model' }));
    expect(result.processedDiaries).toBe(3);
    expect(result.actions).toBe(0);
    expect(diaryStore.undistilledCount()).toBe(0);
  });
});
