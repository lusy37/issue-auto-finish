import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  resolveDataDir,
  ensureDir,
  getGlobalDir,
} from '../../src/paths.js';

describe('paths', () => {
  const originalDataDir = process.env.DATA_DIR;

  beforeEach(() => {
    delete process.env.DATA_DIR;
  });

  afterEach(() => {
    // Restore
    if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir;
    else delete process.env.DATA_DIR;
  });

  describe('resolveDataDir', () => {
    it('respects DATA_DIR environment variable', () => {
      process.env.DATA_DIR = '/tmp/custom-data';
      expect(resolveDataDir()).toBe(path.resolve('/tmp/custom-data'));
    });

    it('resolves relative DATA_DIR to absolute', () => {
      process.env.DATA_DIR = './relative-data';
      const result = resolveDataDir();
      expect(path.isAbsolute(result)).toBe(true);
    });

    it('returns a path ending with /data in source-code mode (no env override)', () => {
      // In test environment __dirname is NOT inside node_modules

        const result = resolveDataDir();
        expect(result).toMatch(/data$/);

    });
  });

  describe('ensureDir', () => {
    it('creates directory if it does not exist', () => {
      const tmpDir = path.join(os.tmpdir(), `iaf-test-${Date.now()}`);
      try {
        expect(fs.existsSync(tmpDir)).toBe(false);
        const result = ensureDir(tmpDir);
        expect(fs.existsSync(tmpDir)).toBe(true);
        expect(result).toBe(tmpDir);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('returns existing directory without error', () => {
      const tmpDir = path.join(os.tmpdir(), `iaf-test-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      try {
        const result = ensureDir(tmpDir);
        expect(result).toBe(tmpDir);
        expect(fs.existsSync(tmpDir)).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('getGlobalDir', () => {
    it('默认独立数据目录', () => {
      const expected = path.resolve('.iaf-mini/github');
      expect(getGlobalDir()).toBe(expected);
    });
  });
});
