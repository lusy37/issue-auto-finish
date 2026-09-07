/**
 * 单元测试：PlanPersistence 全局后备读写与合并边界
 *
 * 后备机制用于解决 reject-plan 时 worktree 不存在导致反馈静默丢失的问题：
 *   - 写：worktree 缺失时 → writeReviewFeedbackBackup 落盘到 DATA_DIR/review-backups/issue-{number}/
 *   - 读：readReviewHistoryBackup 读取后备历史
 *   - 合并：worktree 重建后 mergeBackupIfPresent 把后备合并进 worktree 并清理后备
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';

describe('PlanPersistence backup (worktree-缺失场景的反馈后备)', () => {
  let tmpDir: string;
  let dataDir: string;
  let workDir: string;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-backup-test-'));
    dataDir = path.join(tmpDir, 'data');
    workDir = path.join(tmpDir, 'workdir');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });

    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('readReviewHistoryBackup', () => {
    it('从未有后备时返回空数组', () => {
      expect(PlanPersistence.readReviewHistoryBackup(42)).toEqual([]);
    });

    it('损坏 JSON 时降级返回空数组（不抛异常）', () => {
      const backupDir = path.join(dataDir, 'review-backups', 'issue-42');
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(path.join(backupDir, 'review-history.json'), 'not valid json', 'utf-8');

      expect(PlanPersistence.readReviewHistoryBackup(42)).toEqual([]);
    });

    it('不同 number 互相隔离', () => {
      PlanPersistence.writeReviewFeedbackBackup(42, 'feedback for 42');
      PlanPersistence.writeReviewFeedbackBackup(99, 'feedback for 99');

      const h42 = PlanPersistence.readReviewHistoryBackup(42);
      const h99 = PlanPersistence.readReviewHistoryBackup(99);

      expect(h42).toHaveLength(1);
      expect(h42[0].feedback).toBe('feedback for 42');
      expect(h99).toHaveLength(1);
      expect(h99[0].feedback).toBe('feedback for 99');
    });
  });

  describe('writeReviewFeedbackBackup', () => {
    it('首次写入创建后备目录和文件', () => {
      PlanPersistence.writeReviewFeedbackBackup(42, '第一次反馈');

      const backupFile = path.join(dataDir, 'review-backups', 'issue-42', 'review-history.json');
      expect(fs.existsSync(backupFile)).toBe(true);

      const history = PlanPersistence.readReviewHistoryBackup(42);
      expect(history).toHaveLength(1);
      expect(history[0].round).toBe(1);
      expect(history[0].feedback).toBe('第一次反馈');
    });

    it('多次写入按 round 递增累积', () => {
      PlanPersistence.writeReviewFeedbackBackup(42, '第一次');
      PlanPersistence.writeReviewFeedbackBackup(42, '第二次');
      PlanPersistence.writeReviewFeedbackBackup(42, '第三次');

      const history = PlanPersistence.readReviewHistoryBackup(42);
      expect(history).toHaveLength(3);
      expect(history[0].round).toBe(1);
      expect(history[1].round).toBe(2);
      expect(history[2].round).toBe(3);
    });

    it('生成 ISO 时间戳', () => {
      PlanPersistence.writeReviewFeedbackBackup(42, 'feedback');
      const history = PlanPersistence.readReviewHistoryBackup(42);
      expect(history[0].timestamp).toBeTruthy();
      expect(new Date(history[0].timestamp).getTime()).not.toBeNaN();
    });
  });

  describe('clearReviewBackup', () => {
    it('清除存在的后备目录', () => {
      PlanPersistence.writeReviewFeedbackBackup(42, 'feedback');
      const backupDir = path.join(dataDir, 'review-backups', 'issue-42');
      expect(fs.existsSync(backupDir)).toBe(true);

      PlanPersistence.clearReviewBackup(42);
      expect(fs.existsSync(backupDir)).toBe(false);
    });

    it('对不存在的后备路径不抛异常', () => {
      expect(() => PlanPersistence.clearReviewBackup(9999)).not.toThrow();
    });
  });

  describe('mergeBackupIfPresent', () => {
    it('无后备时不抛异常，worktree 状态不变', () => {
      const plan = new PlanPersistence(workDir, 42);
      plan.ensureDir();

      expect(() => plan.mergeBackupIfPresent()).not.toThrow();
      expect(plan.readReviewHistory()).toEqual([]);
    });

    it('worktree 为空 + 后备有反馈时把后备搬到 worktree', () => {
      PlanPersistence.writeReviewFeedbackBackup(42, '后备反馈 A');
      PlanPersistence.writeReviewFeedbackBackup(42, '后备反馈 B');

      const plan = new PlanPersistence(workDir, 42);
      plan.ensureDir();
      plan.mergeBackupIfPresent();

      const history = plan.readReviewHistory();
      expect(history).toHaveLength(2);
      expect(history.map((r) => r.feedback)).toEqual(['后备反馈 A', '后备反馈 B']);
    });

    it('合并后清理后备目录', () => {
      PlanPersistence.writeReviewFeedbackBackup(42, '后备反馈');

      const plan = new PlanPersistence(workDir, 42);
      plan.ensureDir();
      plan.mergeBackupIfPresent();

      expect(PlanPersistence.readReviewHistoryBackup(42)).toEqual([]);
    });

    it('worktree 已有反馈 + 后备反馈时合并并按时间戳排序，round 顺序重排', () => {
      const plan = new PlanPersistence(workDir, 42);
      plan.ensureDir();
      plan.writeReviewFeedback('worktree 旧反馈 t1');

      PlanPersistence.writeReviewFeedbackBackup(42, '后备反馈 t2');

      plan.mergeBackupIfPresent();

      const history = plan.readReviewHistory();
      expect(history).toHaveLength(2);
      const rounds = history.map((r) => r.round);
      expect(rounds).toEqual([1, 2]);
      const feedbacks = history.map((r) => r.feedback);
      expect(feedbacks).toContain('worktree 旧反馈 t1');
      expect(feedbacks).toContain('后备反馈 t2');
    });

    it('合并后 review-feedback.md 一并刷新', () => {
      PlanPersistence.writeReviewFeedbackBackup(42, '关键缺陷需要修复');

      const plan = new PlanPersistence(workDir, 42);
      plan.ensureDir();
      plan.mergeBackupIfPresent();

      const md = plan.readReviewFeedback();
      expect(md).not.toBeNull();
      expect(md).toContain('关键缺陷需要修复');
    });
  });
});
