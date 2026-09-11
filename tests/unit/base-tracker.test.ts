import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DiaryStore } from '../../src/distill/DiaryStore.js';

/**
 * BaseTracker 错误处理 & tmp 文件清理测试。
 *
 * 通过 DiaryStore（最简单的具体子类）验证 BaseTracker 的通用行为：
 * - save() 失败时不留 tmp 残骸
 * - save() 失败时抛带诊断信息的 wrapped error（含 code/errno/syscall）
 * - 构造时清理同目录下遗留的 .{trackerName}-*.tmp
 */
describe('BaseTracker error handling', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'base-tracker-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('save() throws wrapped error with code/errno/syscall when writeFileSync fails (EDQUOT)', () => {
    const store = new DiaryStore(tmpDir);

    const edquot = new Error('Disk quota exceeded') as NodeJS.ErrnoException;
    edquot.code = 'EDQUOT';
    edquot.errno = -122;
    edquot.syscall = 'open';
    edquot.path = path.join(tmpDir, '.diary-store-fake.tmp');

    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw edquot;
    });

    let caught: NodeJS.ErrnoException | null = null;
    try {
      store.create({
        id: 'd-1',
        kind: 'phase-summary',
        issueIid: 1,
        phase: 'plan',
        title: 'test',
        content: 'x',
        createdAt: new Date().toISOString(),
        distilled: false,
      } as any);
    } catch (err) {
      caught = err as NodeJS.ErrnoException;
    }

    expect(writeSpy).toHaveBeenCalled();
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('EDQUOT');
    expect(caught!.errno).toBe(-122);
    expect(caught!.syscall).toBe('open');
    expect(caught!.message).toContain('diary-store');
    expect(caught!.message).toContain('Disk quota exceeded');
  });

  it('save() removes tmp file when writeFileSync throws after partial creation', () => {
    const store = new DiaryStore(tmpDir);

    const realWrite = fs.writeFileSync;
    let lastTmpPath = '';
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((p, ...rest) => {
      const target = String(p);
      if (target.includes('.diary-store-')) {
        lastTmpPath = target;
        // Simulate partial write — file is created but then quota kicks in
        realWrite.call(fs, target, '');
        const err = new Error('Disk quota exceeded') as NodeJS.ErrnoException;
        err.code = 'EDQUOT';
        err.errno = -122;
        throw err;
      }
      return realWrite.apply(fs, [p, ...rest] as Parameters<typeof fs.writeFileSync>);
    });

    expect(() => {
      store.create({
        id: 'd-1', kind: 'phase-summary', issueIid: 1, phase: 'plan',
        title: 'test', content: 'x',
        createdAt: new Date().toISOString(), distilled: false,
      } as any);
    }).toThrow(/Disk quota exceeded/);

    expect(writeSpy).toHaveBeenCalled();
    expect(lastTmpPath).toBeTruthy();
    expect(fs.existsSync(lastTmpPath)).toBe(false);
  });

  it('constructor cleans up stale .{trackerName}-*.tmp files in data dir', () => {
    // Pre-populate stale tmp files (simulating a prior crash)
    const stale1 = path.join(tmpDir, '.diary-store-12345-1700000000000.tmp');
    const stale2 = path.join(tmpDir, '.diary-store-99999-1700000001000.tmp');
    const unrelated = path.join(tmpDir, '.other-tracker-1.tmp');
    fs.writeFileSync(stale1, '{}');
    fs.writeFileSync(stale2, '{}');
    fs.writeFileSync(unrelated, '{}');

    new DiaryStore(tmpDir);

    expect(fs.existsSync(stale1)).toBe(false);
    expect(fs.existsSync(stale2)).toBe(false);
    // Other tracker's tmp files must NOT be removed (different trackerName prefix)
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it('does not throw when tmp cleanup encounters readdir failure', () => {
    // 强制 readdirSync 抛错，验证清理失败不影响 BaseTracker 实例化（防御式清理）
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw new Error('readdir denied');
    });

    expect(() => new DiaryStore(tmpDir)).not.toThrow();
  });
});
