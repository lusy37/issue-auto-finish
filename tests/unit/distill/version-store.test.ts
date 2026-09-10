import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { VersionStore } from '../../../src/distill/VersionStore.js';

describe('VersionStore', () => {
  let tmpDir: string;
  let store: VersionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-store-'));
    store = new VersionStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends and retrieves version records', () => {
    store.append({
      entryId: 'mem-1',
      version: 1,
      content: 'Initial content',
      action: 'created',
      timestamp: '2025-01-01T00:00:00.000Z',
    });

    const records = store.getByEntryId('mem-1');
    expect(records).toHaveLength(1);
    expect(records[0].action).toBe('created');
  });

  it('tracks multiple versions of the same entry', () => {
    store.append({
      entryId: 'mem-1',
      version: 1,
      content: 'v1',
      action: 'created',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    store.append({
      entryId: 'mem-1',
      version: 2,
      content: 'v2',
      action: 'merged',
      reason: 'New evidence',
      timestamp: '2025-01-02T00:00:00.000Z',
    });

    const records = store.getByEntryId('mem-1');
    expect(records).toHaveLength(2);
    expect(records[0].version).toBe(1);
    expect(records[1].version).toBe(2);
  });

  it('separates entries by ID', () => {
    store.append({
      entryId: 'mem-1',
      version: 1,
      content: 'A',
      action: 'created',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    store.append({
      entryId: 'mem-2',
      version: 1,
      content: 'B',
      action: 'created',
      timestamp: '2025-01-01T00:00:00.000Z',
    });

    expect(store.getByEntryId('mem-1')).toHaveLength(1);
    expect(store.getByEntryId('mem-2')).toHaveLength(1);
  });

  it('persists across instances', () => {
    store.append({
      entryId: 'persist',
      version: 1,
      content: 'data',
      action: 'created',
      timestamp: '2025-01-01T00:00:00.000Z',
    });

    const store2 = new VersionStore(tmpDir);
    expect(store2.getByEntryId('persist')).toHaveLength(1);
  });

  it('reports correct count', () => {
    expect(store.count()).toBe(0);
    store.append({
      entryId: 'a',
      version: 1,
      content: 'x',
      action: 'created',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    expect(store.count()).toBe(1);
  });
});
