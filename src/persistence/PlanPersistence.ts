import fs from 'node:fs';
import path from 'node:path';
import { ProgressData, PhaseProgress, type PhaseStatus } from '../tracker/IssueState.js';
import type { PipelineDef } from '../pipeline/PipelineDefinition.js';
import { resolveDataDir } from '../paths.js';
import { logger as rootLogger } from '../logger.js';

const logger = rootLogger.child('PlanPersistence');

const PLAN_DIR = '.claude-plan';
const BACKUP_ROOT = 'review-backups';

const PLAN_GITIGNORE = '# 仅提交各任务的产物目录。\n*\n!issue-*/\n!issue-*/**\n!.gitignore\n';

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
  /**
   * 确保 .claude-plan/.gitignore 排除临时文件（hooks、事件日志等），
   * 仅保留 issue-* 产物目录。在 git add 之前调用以防止污染 PR。
   */
  static ensureGitignore(workDir: string): void {
    const dir = path.join(workDir, PLAN_DIR);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const gitignorePath = path.join(dir, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      if (content.includes('!issue-*/')) return;
    }
    fs.writeFileSync(gitignorePath, PLAN_GITIGNORE, 'utf-8');
    logger.debug('.claude-plan/.gitignore written', { workDir });
  }

  // ---------------------------------------------------------------------------
  // 全局后备 — 当 worktree 因任何原因不存在时，把审核反馈先持久化到
  // <dataDir>/review-backups/issue-{number}/，下一次 SetupStep 创建 worktree
  // 后再合并回 review-history.json，避免反馈静默丢失。
  // ---------------------------------------------------------------------------

  /** 返回某 Issue 的全局后备目录绝对路径（不保证存在）。 */
  static getReviewBackupDir(issueIid: number): string {
    return path.join(resolveDataDir(), BACKUP_ROOT, `issue-${issueIid}`);
  }

  /** 读取全局后备的审核历史；不存在或解析失败时降级为空数组。 */
  static readReviewHistoryBackup(issueIid: number): ReviewRound[] {
    const filePath = path.join(PlanPersistence.getReviewBackupDir(issueIid), 'review-history.json');
    if (!fs.existsSync(filePath)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  /**
   * 把一轮反馈追加到全局后备 review-history.json（append-only）。
   *
   * @param planSnapshot 驳回时 01-plan.md 的完整内容；若 worktree 缺失无法读取，
   *                     可传 undefined（diff 对比能力会降级，但反馈本身仍能保住）。
   * @param reviewedSessionId 驳回时 plan 阶段使用的 sessionId；worktree 缺失场景
   *                     通常拿不到，传 undefined 即可（fallback 到 prompt 注入）。
   */
  static writeReviewFeedbackBackup(
    issueIid: number,
    content: string,
    planSnapshot?: string,
    reviewedSessionId?: string,
  ): void {
    const dir = PlanPersistence.getReviewBackupDir(issueIid);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const history = PlanPersistence.readReviewHistoryBackup(issueIid);
    const round: ReviewRound = {
      round: history.length + 1,
      feedback: content,
      timestamp: new Date().toISOString(),
      ...(planSnapshot !== undefined ? { planSnapshot } : {}),
      ...(reviewedSessionId !== undefined ? { reviewedSessionId } : {}),
    };
    history.push(round);
    fs.writeFileSync(
      path.join(dir, 'review-history.json'),
      JSON.stringify(history, null, 2),
      'utf-8',
    );
    logger.warn('Review feedback persisted to backup (worktree unavailable)', {
      issueIid, round: round.round, hasSnapshot: planSnapshot !== undefined, hasSessionId: reviewedSessionId !== undefined,
    });
  }

  /** 清空某 Issue 的全局后备目录（合并完毕后调用）。 */
  static clearReviewBackup(issueIid: number): void {
    const dir = PlanPersistence.getReviewBackupDir(issueIid);
    if (!fs.existsSync(dir)) return;
    fs.rmSync(dir, { recursive: true, force: true });
    logger.info('Review backup cleared', { issueIid });
  }

  private workDir: string;
  private issueIid: number;

  constructor(workDir: string, issueIid: number) {
    this.workDir = workDir;
    this.issueIid = issueIid;
  }

  get baseDir(): string {
    return this.workDir;
  }

  get planDir(): string {
    return path.join(this.workDir, PLAN_DIR, `issue-${this.issueIid}`);
  }

  ensureDir(): void {
    if (!fs.existsSync(this.planDir)) {
      fs.mkdirSync(this.planDir, { recursive: true });
    }
  }

  writeIssueMeta(meta: { id: number; number: number; title: string; labels: string[]; state: string }): void {
    this.ensureDir();
    const filePath = path.join(this.planDir, 'issue-meta.json');
    fs.writeFileSync(filePath, JSON.stringify(meta, null, 2), 'utf-8');
    logger.info('Issue meta written');
  }

  writeProgress(data: ProgressData): void {
    this.ensureDir();
    const filePath = path.join(this.planDir, 'progress.json');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    logger.debug('Progress written', { currentPhase: data.currentPhase });
  }

  readProgress(): ProgressData | null {
    const filePath = path.join(this.planDir, 'progress.json');
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }
  }

  getAllPlanFiles(): string[] {
    if (!fs.existsSync(this.planDir)) return [];
    return fs.readdirSync(this.planDir).map((f) => path.join(PLAN_DIR, `issue-${this.issueIid}`, f));
  }

  /** 根据当前流水线创建进度，不再提供旧分析／设计流程的默认值。 */
  createInitialProgress(displayId: number, title: string, branchName: string, def: PipelineDef): ProgressData {
    const phases: Record<string, PhaseProgress> = {};
    for (const spec of def.phases) phases[spec.name] = { status: 'pending' };
    return { displayId, title, branchName, pipelineMode: def.mode, currentPhase: def.phases[0].name, phases };
  }

  writePlan(content: string): void {
    this.ensureDir();
    fs.writeFileSync(path.join(this.planDir, '01-plan.md'), content, 'utf-8');
    logger.info('Plan document written');
  }

  /**
   * 把一轮反馈追加到 worktree 内的 review-history.json + review-feedback.md。
   *
   * @param planSnapshot 驳回时 01-plan.md 的完整内容，用于支持"本轮 vs 上轮"对比
   *                     和知识库蒸馏。当 01-plan.md 不存在时传 undefined（首轮异常路径）。
   * @param reviewedSessionId 驳回时 plan 阶段使用的 AI session id；
   *                     用于下一轮 plan 重跑时优先 `--resume` 续聊（仅在 runner
   *                     `planModeResumable=true` 时生效）。无法获取时传 undefined，
   *                     不影响功能正确性（自动 fallback 到 prompt 注入）。
   */
  writeReviewFeedback(content: string, planSnapshot?: string, reviewedSessionId?: string): void {
    this.ensureDir();
    const history = this.readReviewHistory();
    const round: ReviewRound = {
      round: history.length + 1,
      feedback: content,
      timestamp: new Date().toISOString(),
      ...(planSnapshot !== undefined ? { planSnapshot } : {}),
      ...(reviewedSessionId !== undefined ? { reviewedSessionId } : {}),
    };
    history.push(round);
    fs.writeFileSync(
      path.join(this.planDir, 'review-history.json'),
      JSON.stringify(history, null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(this.planDir, 'review-feedback.md'),
      PlanPersistence.renderReviewHistoryMarkdown(history),
      'utf-8',
    );
    logger.info('Review feedback appended', {
      round: round.round, hasSnapshot: planSnapshot !== undefined, hasSessionId: reviewedSessionId !== undefined,
    });
  }

  /**
   * 若全局后备目录存在审核反馈，则合并进 worktree 的 review-history.json：
   *   1. 读取 existing(worktree) + backup
   *   2. 按 timestamp 稳定排序
   *   3. 重新分配 round 号
   *   4. 重写 worktree 的 review-history.json + review-feedback.md
   *   5. 清理后备目录
   *
   * 用于 SetupStep 在 worktree 重建后调用，避免 worktree 缺失期间收到的
   * 反馈丢失。
   */
  mergeBackupIfPresent(): void {
    const backupHistory = PlanPersistence.readReviewHistoryBackup(this.issueIid);
    if (backupHistory.length === 0) return;

    const existing = this.readReviewHistory();
    const combined = [...existing, ...backupHistory];
    combined.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const renumbered: ReviewRound[] = combined.map((r, idx) => ({ ...r, round: idx + 1 }));

    this.ensureDir();
    fs.writeFileSync(
      path.join(this.planDir, 'review-history.json'),
      JSON.stringify(renumbered, null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(this.planDir, 'review-feedback.md'),
      PlanPersistence.renderReviewHistoryMarkdown(renumbered),
      'utf-8',
    );
    PlanPersistence.clearReviewBackup(this.issueIid);
    logger.info('Review backup merged into worktree', {
      issueIid: this.issueIid,
      total: renumbered.length,
      mergedFromBackup: backupHistory.length,
    });
  }

  readReviewFeedback(): string | null {
    const filePath = path.join(this.planDir, 'review-feedback.md');
    if (!fs.existsSync(filePath)) return null;
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  readReviewHistory(): ReviewRound[] {
    const filePath = path.join(this.planDir, 'review-history.json');
    if (!fs.existsSync(filePath)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
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

  updatePhaseProgress(
    phaseName: string,
    status: PhaseStatus,
    error?: string,
    options?: { preserveSessionId?: boolean },
  ): void {
    const progress = this.readProgress();
    if (!progress) {
      logger.warn('Cannot update phase progress: progress.json not found', {
        issueIid: this.issueIid, phase: phaseName, targetStatus: status,
      });
      return;
    }

    const now = new Date().toISOString();
    if (!progress.phases[phaseName]) {
      progress.phases[phaseName] = { status: 'pending' };
    }
    const phase = progress.phases[phaseName];

    phase.status = status;
    if (status === 'in_progress') {
      phase.startedAt = now;
      progress.currentPhase = phaseName;
      if (!options?.preserveSessionId) {
        delete phase.sessionId;
      }
    } else if (status === 'completed') {
      phase.completedAt = now;
    } else if (status === 'failed') {
      phase.error = error;
    }

    this.writeProgress(progress);
  }

  updatePhaseSessionId(phaseName: string, sessionId: string): void {
    const progress = this.readProgress();
    if (!progress?.phases[phaseName]) return;
    progress.phases[phaseName].sessionId = sessionId;
    this.writeProgress(progress);
  }

  getPhaseSessionId(phaseName: string): string | undefined {
    const progress = this.readProgress();
    return progress?.phases[phaseName]?.sessionId;
  }

  // ---------------------------------------------------------------------------
  // 通用文件操作 — 替代阶段中散落的 fs 直接调用
  // ---------------------------------------------------------------------------

  /** 读取 planDir 下指定文件，不存在返回 null */
  readFile(filename: string): string | null {
    const filePath = path.join(this.planDir, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  /** 检查 planDir 下指定文件是否就绪（存在 + 大于 minBytes） */
  isArtifactReady(filename: string, minBytes = 50): boolean {
    const filePath = path.join(this.planDir, filename);
    if (!fs.existsSync(filePath)) return false;
    try {
      return fs.statSync(filePath).size >= minBytes;
    } catch {
      return false;
    }
  }

  /** 写入 planDir 下指定文件（自动 ensureDir） */
  writeFile(filename: string, content: string): void {
    this.ensureDir();
    fs.writeFileSync(path.join(this.planDir, filename), content, 'utf-8');
  }
}
