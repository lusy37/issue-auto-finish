import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { DiaryStore } from '../../../src/distill/DiaryStore.js';
import type { DiaryEntry } from '../../../src/distill/types.js';

function makeDiary(overrides: Partial<DiaryEntry> = {}): DiaryEntry {
  return {
    id: overrides.id ?? 'diary-1',
    issueIid: 42,
    issueTitle: 'Test Issue',
    branchName: 'feat/issue-42',
    pipelineMode: 'classic',
    outcome: 'completed',
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
    ...overrides,
  };
}

describe('DiaryStore', () => {
  let tmpDir: string;
  let store: DiaryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-store-'));
    store = new DiaryStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates and retrieves a diary entry', () => {
    const diary = makeDiary();
    store.create(diary);
    expect(store.get('diary-1')).toEqual(diary);
  });

  it('returns all entries', () => {
    store.create(makeDiary({ id: 'a' }));
    store.create(makeDiary({ id: 'b' }));
    expect(store.getAll()).toHaveLength(2);
  });

  it('filters undistilled entries', () => {
    store.create(makeDiary({ id: 'a', distilled: false }));
    store.create(makeDiary({ id: 'b', distilled: true }));
    expect(store.getUndistilled()).toHaveLength(1);
    expect(store.getUndistilled()[0].id).toBe('a');
  });

  it('marks entries as distilled', () => {
    store.create(makeDiary({ id: 'a', distilled: false }));
    store.create(makeDiary({ id: 'b', distilled: false }));
    store.markDistilled(['a']);
    expect(store.get('a')?.distilled).toBe(true);
    expect(store.get('b')?.distilled).toBe(false);
  });

  it('filters by issueIid', () => {
    store.create(makeDiary({ id: 'a', issueIid: 42 }));
    store.create(makeDiary({ id: 'b', issueIid: 99 }));
    expect(store.getByIssueIid(42)).toHaveLength(1);
  });

  it('deletes an entry', () => {
    store.create(makeDiary({ id: 'a' }));
    expect(store.delete('a')).toBe(true);
    expect(store.get('a')).toBeUndefined();
  });

  it('persists data to file', () => {
    store.create(makeDiary({ id: 'persist-test' }));
    // Create new instance to verify persistence
    const store2 = new DiaryStore(tmpDir);
    expect(store2.get('persist-test')).toBeDefined();
  });

  it('reports correct counts', () => {
    store.create(makeDiary({ id: 'a', distilled: false }));
    store.create(makeDiary({ id: 'b', distilled: true }));
    expect(store.count()).toBe(2);
    expect(store.undistilledCount()).toBe(1);
  });
});
