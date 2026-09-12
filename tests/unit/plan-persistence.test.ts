import { buildPlanModePipeline } from '../../src/pipeline/PipelineDefinition.js';
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

  describe('ensureGitignore', () => {
    it('creates .claude-plan/.gitignore that excludes temp files but keeps issue-*/', () => {
      PlanPersistence.ensureGitignore(tmpDir);

      const gitignorePath = path.join(tmpDir, '.claude-plan', '.gitignore');
      expect(fs.existsSync(gitignorePath)).toBe(true);

      const content = fs.readFileSync(gitignorePath, 'utf-8');
      expect(content).toContain('*');
      expect(content).toContain('!issue-*/');
      expect(content).toContain('!issue-*/**');
      expect(content).toContain('!.gitignore');
    });

    it('is idempotent — does not overwrite if already correct', () => {
      PlanPersistence.ensureGitignore(tmpDir);
      const gitignorePath = path.join(tmpDir, '.claude-plan', '.gitignore');
      const first = fs.readFileSync(gitignorePath, 'utf-8');

      PlanPersistence.ensureGitignore(tmpDir);
      const second = fs.readFileSync(gitignorePath, 'utf-8');

      expect(first).toBe(second);
    });

    it('补齐只有 .phase-prompt.md 的忽略配置', () => {
      const dir = path.join(tmpDir, '.claude-plan');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '.gitignore'), '.phase-prompt.md\n', 'utf-8');

      PlanPersistence.ensureGitignore(tmpDir);

      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
      expect(content).toContain('!issue-*/');
    });

    it('creates .claude-plan/ directory if it does not exist', () => {
      const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-gi-'));
      PlanPersistence.ensureGitignore(freshDir);

      expect(fs.existsSync(path.join(freshDir, '.claude-plan', '.gitignore'))).toBe(true);
      fs.rmSync(freshDir, { recursive: true, force: true });
    });
  });

  it('ensureDir creates .claude-plan/issue-{number}/ directory', () => {
    const plan = new PlanPersistence(tmpDir, 42);
    plan.ensureDir();

    const planDir = path.join(tmpDir, '.claude-plan', 'issue-42');
    expect(fs.existsSync(planDir)).toBe(true);
    expect(fs.statSync(planDir).isDirectory()).toBe(true);
  });

  it('readProgress returns null when no progress file exists', () => {
    const plan = new PlanPersistence(tmpDir, 42);
    expect(plan.readProgress()).toBeNull();
  });

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
      const historyPath = path.join(tmpDir, '.claude-plan', 'issue-42', 'review-history.json');
      fs.writeFileSync(historyPath, 'not valid json', 'utf-8');

      expect(plan.readReviewHistory()).toEqual([]);
    });
  });

  describe('updatePhaseProgress', () => {
    it('returns gracefully when progress.json does not exist (no throw)', () => {
      const plan = new PlanPersistence(tmpDir, 42);
      // 不应抛异常，且不应创建文件
      expect(() => plan.updatePhaseProgress('review', 'completed')).not.toThrow();
      expect(plan.readProgress()).toBeNull();
    });

    it('updates status normally when progress.json exists', () => {
      const plan = new PlanPersistence(tmpDir, 42);
      const initial = plan.createInitialProgress(42, 'Test', 'feat/issue-42', buildPlanModePipeline({ e2eEnabled: true }));
      plan.writeProgress(initial);

      plan.updatePhaseProgress('plan', 'in_progress');
      const progress = plan.readProgress();
      expect(progress?.phases.plan.status).toBe('in_progress');
      expect(progress?.phases.plan.startedAt).toBeTruthy();
    });
  });
});
