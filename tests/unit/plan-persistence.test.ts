import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';

describe('PlanPersistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('baseDir getter returns the workDir passed to constructor', () => {
    const plan = new PlanPersistence(tmpDir, 42);
    expect(plan.baseDir).toBe(tmpDir);
  });

  describe('运行产物与仓库隔离', () => {
    it('不会向目标仓库创建内部产物目录', () => { PlanPersistence.ensureGitignore(tmpDir); expect(fs.existsSync(path.join(tmpDir, '.claude-plan'))).toBe(false); });
    it('重复初始化保持目标仓库内容不变', () => { fs.writeFileSync(path.join(tmpDir, 'README.md'), '原内容'); PlanPersistence.ensureGitignore(tmpDir); PlanPersistence.ensureGitignore(tmpDir); expect(fs.readdirSync(tmpDir)).toEqual(['README.md']); });
    it('不会修改仓库现存的忽略配置', () => { fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/'); PlanPersistence.ensureGitignore(tmpDir); expect(fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8')).toBe('node_modules/'); });
    it('没有仓库目录也能保存产物', () => { const plan = new PlanPersistence(path.join(tmpDir, '不存在'), 42); plan.writePlan('完整计划'); expect(plan.readFile('01-plan.md')).toBe('完整计划'); });
  });
  it('产物目录在显式 DATA_DIR 下', () => { const plan = new PlanPersistence(tmpDir, 42); plan.ensureDir(); expect(plan.planDir).toBe(path.join(process.env.DATA_DIR!, 'issues', '42', 'artifacts')); expect(fs.existsSync(plan.planDir)).toBe(true); });

  describe('review history (multi-round feedback)', () => {
    it('readReviewHistory returns empty array when no history exists', () => {
      const plan = new PlanPersistence(tmpDir, 42);
      expect(plan.readReviewHistory()).toEqual([]);
    });

    it('writeReviewFeedback appends to review-history.json', () => {
      const plan = new PlanPersistence(tmpDir, 42);
      plan.writeReviewFeedback('第一次反馈');
      plan.writeReviewFeedback('第二次反馈');

      const history = plan.readReviewHistory();
      expect(history).toHaveLength(2);
      expect(history[0].round).toBe(1);
      expect(history[0].feedback).toBe('第一次反馈');
      expect(history[1].round).toBe(2);
      expect(history[1].feedback).toBe('第二次反馈');
    });

    it('each round has a valid timestamp', () => {
      const plan = new PlanPersistence(tmpDir, 42);
      plan.writeReviewFeedback('test feedback');

      const history = plan.readReviewHistory();
      expect(history[0].timestamp).toBeTruthy();
      expect(new Date(history[0].timestamp).getTime()).not.toBeNaN();
    });

    it('writeReviewFeedback regenerates review-feedback.md with all rounds', () => {
      const plan = new PlanPersistence(tmpDir, 42);
      plan.writeReviewFeedback('第一次反馈');
      plan.writeReviewFeedback('第二次反馈');

      const md = plan.readReviewFeedback();
      expect(md).not.toBeNull();
      expect(md).toContain('第 1 轮审核反馈');
      expect(md).toContain('第一次反馈');
      expect(md).toContain('第 2 轮审核反馈');
      expect(md).toContain('第二次反馈');
    });

    it('readReviewFeedback returns null when no feedback exists', () => {
      const plan = new PlanPersistence(tmpDir, 42);
      expect(plan.readReviewFeedback()).toBeNull();
    });

    it('renderReviewHistoryMarkdown formats history correctly', () => {
      const md = PlanPersistence.renderReviewHistoryMarkdown([
        { round: 1, feedback: 'fix bug A', timestamp: '2025-01-01T00:00:00Z' },
        { round: 2, feedback: 'also fix bug B', timestamp: '2025-01-02T00:00:00Z' },
      ]);
      expect(md).toContain('# 审核反馈历史');
      expect(md).toContain('## 第 1 轮审核反馈');
      expect(md).toContain('fix bug A');
      expect(md).toContain('## 第 2 轮审核反馈');
      expect(md).toContain('also fix bug B');
    });

    it('renderReviewHistoryMarkdown returns empty string for empty history', () => {
      expect(PlanPersistence.renderReviewHistoryMarkdown([])).toBe('');
    });

    it('readReviewHistory handles corrupted JSON gracefully', () => {
      const plan = new PlanPersistence(tmpDir, 42);
      plan.ensureDir();
      const historyPath = path.join(plan.planDir, 'review-history.json');
      fs.writeFileSync(historyPath, 'not valid json', 'utf-8');

      expect(plan.readReviewHistory()).toEqual([]);
    });
  });

  it('不会生成重复的 progress.json 状态文件', () => {
    const plan = new PlanPersistence(tmpDir, 42);
    plan.ensureDir();
    expect(fs.existsSync(path.join(plan.planDir, 'progress.json'))).toBe(false);
  });
});
