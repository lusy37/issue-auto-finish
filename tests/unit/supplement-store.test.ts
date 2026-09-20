import { githubIssueToDemandSpec } from '../../src/demand/adapters/GitHubAdapter.js';
import { demandToPromptContext } from '../../src/prompts/templates.js';
import { createTestIssue } from '../helpers/mock-factories.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SupplementStore } from '../../src/supplement/SupplementStore.js';

describe('SupplementStore', () => {
  let tmpDir: string;
  let store: SupplementStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supplement-test-'));
    store = new SupplementStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null for non-existent supplement', () => {
    expect(store.get(999)).toBeNull();
  });

  it('saves and retrieves supplement', () => {
    const data = {
      requirements: '需要支持分页',
      acceptanceCriteria: '验收标准',
      scope: '仅后端',
      constraints: '需兼容旧版本',
      references: 'https://example.com',
      freeText: '自由文本',
    };

    const saved = store.save(42, data);

    expect(saved.requirements).toBe('需要支持分页');
    expect(saved.updatedAt).toBeTruthy();

    const loaded = store.get(42);
    expect(loaded).not.toBeNull();
    expect(loaded!.requirements).toBe('需要支持分页');
    expect(loaded!.scope).toBe('仅后端');
  });

  it('creates supplements directory on save', () => {
    const supplementsDir = path.join(tmpDir, 'supplements');
    expect(fs.existsSync(supplementsDir)).toBe(false);

    store.save(1, {
      requirements: '', acceptanceCriteria: '', scope: '',
      constraints: '', references: '', freeText: 'test',
    });

    expect(fs.existsSync(supplementsDir)).toBe(true);
  });

  it('deletes supplement', () => {
    store.save(42, {
      requirements: 'test', acceptanceCriteria: '', scope: '',
      constraints: '', references: '', freeText: '',
    });

    expect(store.get(42)).not.toBeNull();
    expect(store.delete(42)).toBe(true);
    expect(store.get(42)).toBeNull();
  });

  it('delete returns false for non-existent supplement', () => {
    expect(store.delete(999)).toBe(false);
  });

  it('generates prompt text from supplement', () => {
    store.save(42, {
      requirements: '需要实现搜索功能',
      acceptanceCriteria: '能按关键字搜索',
      scope: '',
      constraints: '',
      references: '',
      freeText: '',
    });

    const text = demandToPromptContext(githubIssueToDemandSpec(createTestIssue(), store.get(42))).supplementText;
    expect(text).toContain('## 补充信息');
    expect(text).toContain('### 补充需求说明');
    expect(text).toContain('需要实现搜索功能');
    expect(text).toContain('### 验收标准');
    expect(text).toContain('能按关键字搜索');
    expect(text).not.toContain('### 变更范围');
  });

  it('returns empty string for prompt text when no supplement', () => {
    expect(demandToPromptContext(githubIssueToDemandSpec(createTestIssue(), store.get(999))).supplementText).toBe('');
  });

  it('returns empty string for prompt text when all fields empty', () => {
    store.save(42, {
      requirements: '', acceptanceCriteria: '', scope: '',
      constraints: '', references: '', freeText: '',
    });

    expect(demandToPromptContext(githubIssueToDemandSpec(createTestIssue(), store.get(42))).supplementText).toBe('');
  });

  it('overwrites existing supplement on save', () => {
    store.save(42, {
      requirements: 'v1', acceptanceCriteria: '', scope: '',
      constraints: '', references: '', freeText: '',
    });

    store.save(42, {
      requirements: 'v2', acceptanceCriteria: '', scope: '',
      constraints: '', references: '', freeText: '',
    });

    const loaded = store.get(42);
    expect(loaded!.requirements).toBe('v2');
  });
});
