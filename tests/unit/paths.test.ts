import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  resolveDataDir,
  resolveLogsDir,
  ensureDir,
  getGlobalDir,
} from '../../src/paths.js';

describe('paths', () => {
  const originalDataDir = process.env.DATA_DIR;
  const originalLogsDir = process.env.LOGS_DIR;

  beforeEach(() => {
    delete process.env.DATA_DIR;
    delete process.env.LOGS_DIR;
  });

  afterEach(() => {
    // Restore
    if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir;
    else delete process.env.DATA_DIR;
    if (originalLogsDir !== undefined) process.env.LOGS_DIR = originalLogsDir;
    else delete process.env.LOGS_DIR;
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

  describe('resolveLogsDir', () => {
    it('respects LOGS_DIR environment variable', () => {
      process.env.LOGS_DIR = '/tmp/custom-logs';
      expect(resolveLogsDir()).toBe(path.resolve('/tmp/custom-logs'));
    });

    it('returns a path ending with /logs in source-code mode', () => {

        const result = resolveLogsDir();
        expect(result).toMatch(/logs$/);

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
