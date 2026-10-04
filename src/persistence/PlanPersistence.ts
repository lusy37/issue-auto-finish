import { ARTIFACTS } from '../shared/runtime/artifacts.js';
import { resolveIssueArtifactsDir, resolveIssueArtifactPath } from './ArtifactPaths.js';
import type { IssueTracker } from '../tracker/IssueTracker.js';
import { renderPlan } from '../dag/contracts.js';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '../paths.js';
import { logger as rootLogger } from '../logger.js';
import { writeTextAtomicSync } from '../utils/atomicFile.js';

const logger = rootLogger.child('PlanPersistence');

export interface ReviewRound {
  round: number;
  feedback: string;
  timestamp: string;
  /** 驳回时的计划快照，供重新规划、差异查看和经验采集使用。 */
  planSnapshot?: string;
  /** AI 执行器的会话标识，用于恢复计划上下文。 */
  reviewedSessionId?: string;
}

export class PlanPersistence {
  private workDir: string;
  private issueIid: number;

  constructor(
    workDir: string,
    issueIid: number,
    private readonly dataDir = resolveDataDir(),
    private readonly tracker?: IssueTracker,
  ) {
    this.workDir = workDir;
    this.issueIid = issueIid;
  }

  get baseDir(): string {
    return this.workDir;
  }

  /** 当前 Issue 使用的数据根目录，供 UAT 结果存储复用同一配置。 */
  get dataDirectory(): string {
    return this.dataDir;
  }

  get planDir(): string {
    return resolveIssueArtifactsDir(this.issueIid, this.dataDir);
  }

  artifactPath(filename: string): string {
    return resolveIssueArtifactPath(this.issueIid, filename, this.dataDir);
  }

  ensureDir(): void {
    if (!fs.existsSync(this.planDir)) {
      fs.mkdirSync(this.planDir, { recursive: true });
    }
  }

  writeIssueMeta(meta: {
    id: number;
    number: number;
    title: string;
    labels: string[];
    state: string;
  }): void {
    this.ensureDir();
    const filePath = this.artifactPath(ARTIFACTS.issueMeta.filename);
    writeTextAtomicSync(filePath, JSON.stringify(meta, null, 2));
    logger.info('Issue meta written');
  }

  getAllPlanFiles(): string[] {
    if (!fs.existsSync(this.planDir)) return [];
    return fs.readdirSync(this.planDir).map((f) => path.join(this.planDir, f));
  }

  writePlan(content: string): void {
    this.ensureDir();
    writeTextAtomicSync(this.artifactPath(ARTIFACTS.plan.filename), content);
    logger.info('Plan document written');
  }

  /** 审核事实只从当前 Issue 聚合记录读取，不读取后备文件或展示副本。 */
  readReviewHistory(): ReviewRound[] {
    return this.tracker?.get(this.issueIid)?.run.reviewHistory ?? [];
  }

  readReviewFeedback(): string | null {
    const history = this.readReviewHistory();
    return history.length ? PlanPersistence.renderReviewHistoryMarkdown(history) : null;
  }

  static renderReviewHistoryMarkdown(history: ReviewRound[]): string {
    if (history.length === 0) return '';
    const lines = ['# 审核反馈历史', ''];
    for (const r of history) {
      lines.push(`## 第 ${r.round} 轮审核反馈`);
      lines.push(`> 时间: ${r.timestamp}`);
      lines.push('');
      lines.push(r.feedback);
      lines.push('');
    }
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // 通用文件操作 — 替代阶段中散落的 fs 直接调用
  // ---------------------------------------------------------------------------

  /** 读取 planDir 下指定文件，不存在返回 null */
  readFile(filename: string): string | null {
    if (filename === ARTIFACTS.plan.filename && this.tracker) {
      const run = this.tracker.get(this.issueIid)?.run;
      if (run?.planRevision && run.planDigest)
        return renderPlan(
          this.tracker.store.readPlan(this.issueIid, run.planRevision, run.planDigest),
        );
      return null;
    }
    if (
      filename === ARTIFACTS.reviewFeedback.filename ||
      filename === ARTIFACTS.reviewHistory.filename
    ) {
      const history = this.readReviewHistory();
      if (filename === ARTIFACTS.reviewHistory.filename) return JSON.stringify(history, null, 2);
      return history.length ? PlanPersistence.renderReviewHistoryMarkdown(history) : null;
    }
    const filePath = this.artifactPath(filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  /** 检查 planDir 下指定文件是否就绪（存在 + 大于 minBytes） */
  isArtifactReady(filename: string, minBytes = 50): boolean {
    const filePath = this.artifactPath(filename);
    if (!fs.existsSync(filePath)) return false;
    try {
      return fs.statSync(filePath).size >= minBytes;
    } catch {
      return false;
    }
  }

  /** 写入 planDir 下指定文件（自动 ensureDir） */
  writeFile(filename: string, content: string): void {
    if (filename === ARTIFACTS.plan.filename)
      throw new Error('计划展示副本只读，请生成结构化计划版本');
    this.ensureDir();
    writeTextAtomicSync(this.artifactPath(filename), content);
  }
}
