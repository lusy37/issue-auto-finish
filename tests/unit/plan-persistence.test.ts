import { createReviewStore } from '../helpers/review-store.js';
import { newTracker } from '../helpers/dag-repository.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import { ARTIFACTS } from '../../src/shared/runtime/artifacts.js';

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
    it('实际保存产物不会修改仓库内容或忽略配置', () => {
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '原内容');
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/');
      const plan = new PlanPersistence(tmpDir, 42);
      plan.writePlan('完整计划');
      plan.writeFile(ARTIFACTS.verifyReport.filename, '本次验证报告');
      expect(fs.readdirSync(tmpDir).sort()).toEqual(['.gitignore', 'README.md']);
      expect(fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8')).toBe('node_modules/');
      expect(plan.readFile(ARTIFACTS.verifyReport.filename)).toBe('本次验证报告');
    });
    it('带空格的显式数据目录与缺失的 worktree 不影响产物保存', () => {
      const dataDir = path.join(tmpDir, '独立运行 数据');
      const plan = new PlanPersistence(path.join(tmpDir, '不存在的工作树'), 42, dataDir);
      plan.writeFile(ARTIFACTS.uatRun.filename, '{"runId":"current-run"}');
      expect(plan.artifactPath(ARTIFACTS.uatRun.filename)).toBe(path.join(dataDir, 'issues', '42', 'artifacts', 'uat-run.json'));
      expect(plan.readFile(ARTIFACTS.uatRun.filename)).toContain('current-run');
      expect(fs.existsSync(plan.baseDir)).toBe(false);
    });
    it.each(['../run.json', '..\\run.json'])('拒绝产物文件名越出目录：%s', filename => {
      const plan = new PlanPersistence(tmpDir, 42);
      expect(() => plan.writeFile(filename, '错误写入')).toThrow('单个文件名');
      expect(() => plan.readFile(filename)).toThrow('单个文件名');
    });
    it('没有仓库目录也能保存产物', () => { const plan = new PlanPersistence(path.join(tmpDir, '不存在'), 42); plan.writePlan('完整计划'); expect(plan.readFile('01-plan.md')).toBe('完整计划'); });
  });
  it('产物目录在显式 DATA_DIR 下', () => { const plan = new PlanPersistence(tmpDir, 42); plan.ensureDir(); expect(plan.planDir).toBe(path.join(process.env.DATA_DIR!, 'issues', '42', 'artifacts')); expect(fs.existsSync(plan.planDir)).toBe(true); });

  describe('聚合审核历史', () => {
    let review: ReturnType<typeof createReviewStore>;
    beforeEach(() => { review = createReviewStore(tmpDir); });
    it('readReviewHistory returns empty array when no history exists', () => {
      const plan = review.plan;
      expect(plan.readReviewHistory()).toEqual([]);
    });

    it('聚合事务按顺序保留多轮审核反馈', () => {
      const plan = review.plan;
      review.appendFeedback('第一次反馈');
      review.appendFeedback('第二次反馈');

      const history = plan.readReviewHistory();
      expect(history).toHaveLength(2);
      expect(history[0].round).toBe(1);
      expect(history[0].feedback).toBe('第一次反馈');
      expect(history[1].round).toBe(2);
      expect(history[1].feedback).toBe('第二次反馈');
    });

    it('each round has a valid timestamp', () => {
      const plan = review.plan;
      review.appendFeedback('test feedback');

      const history = plan.readReviewHistory();
      expect(history[0].timestamp).toBeTruthy();
      expect(new Date(history[0].timestamp).getTime()).not.toBeNaN();
    });

    it('审核反馈展示由聚合历史生成', () => {
      const plan = review.plan;
      review.appendFeedback('第一次反馈');
      review.appendFeedback('第二次反馈');

      const md = plan.readReviewFeedback();
      expect(md).not.toBeNull();
      expect(md).toContain('第 1 轮审核反馈');
      expect(md).toContain('第一次反馈');
      expect(md).toContain('第 2 轮审核反馈');
      expect(md).toContain('第二次反馈');
    });

    it('重启且工作树不存在时仍能读取完整审核历史', () => {
      review.appendFeedback('反馈一', '第一版完整计划');
      review.appendFeedback('反馈二', '第二版完整计划');
      const restored = new PlanPersistence(path.join(tmpDir, '缺失工作树'), 42, review.tracker.store.dataDir, newTracker(review.tracker.store.dataDir));
      expect(restored.readReviewHistory()).toEqual(review.plan.readReviewHistory());
      expect(restored.readReviewFeedback()).toContain('反馈二');
    });

    it('不同 Issue 的审核资料相互隔离', () => {
      const other = createReviewStore(tmpDir, 99);
      review.appendFeedback('Issue 42 的反馈');
      other.appendFeedback('Issue 99 的反馈');
      expect(review.plan.readReviewFeedback()).not.toContain('Issue 99');
      expect(other.plan.readReviewFeedback()).not.toContain('Issue 42');
    });

    it('readReviewFeedback returns null when no feedback exists', () => {
      const plan = review.plan;
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

    it('产物展示文件不能覆盖聚合审核事实', () => {
      const plan = review.plan;
      plan.ensureDir();
      const historyPath = path.join(plan.planDir, 'review-history.json');
      review.appendFeedback('当前有效反馈');
      fs.writeFileSync(historyPath, '展示文件被改写', 'utf-8');
      expect(plan.readReviewHistory().map(round => round.feedback)).toEqual(['当前有效反馈']);
    });
  });

  it('不会生成重复的 progress.json 状态文件', () => {
    const plan = new PlanPersistence(tmpDir, 42);
    plan.ensureDir();
    expect(fs.existsSync(path.join(plan.planDir, 'progress.json'))).toBe(false);
  });
});
