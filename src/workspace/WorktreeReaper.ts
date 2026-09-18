/**
 * WorktreeReaper — 已完成 issue 的 worktree 延迟清理。
 *
 * 系统默认不再于 issue 完成时立即删除 worktree，而是保留
 * config.worktree.retentionMs（默认 7 天）。本 reaper 周期性扫描 tracker，
 * 将「保留期已满且尚未清理」的已完成 / 已部署 issue 的 worktree（单仓工作目录）清理掉；远端分支保留以便后续 PR。
 *
 * 保留期内用户仍可重启预览、检查代码或修复冲突。失败态的 worktree 不在回收范围内
 * （保留以便调试），与既有行为一致。
 */
import { logger as rootLogger } from '../logger.js';
import { isShuttingDown } from '../shutdown/ShutdownSignal.js';
import type { IssueRecord } from '../tracker/IssueRecord.js';
import { getIssueNumber } from '../tracker/IssueRecordHelper.js';
import type { IssueService } from '../orchestrator/IssueService.js';

const logger = rootLogger.child('WorktreeReaper');

export interface WorktreeReaperDeps {
  /** 单实例编排器，每个内部持有自己的 tracker 与清理能力。 */
  orchestrator: IssueService;
  /** 扫描间隔（毫秒）。 */
  intervalMs: number;
  /** 完成后保留时长（毫秒），超过即回收。 */
  retentionMs: number;
  /** 是否启用自动清理。false 时永久保留 worktree。 */
  enabled: boolean;
}

export interface WorktreeReapResult {
  reaped: number;
  iids: number[];
}

export interface WorktreeReaperStatus {
  running: boolean;
  enabled: boolean;
  lastScanAt?: string;
  totalReaped: number;
  intervalMs: number;
  retentionMs: number;
}

export class WorktreeReaper {
  private orchestrator: IssueService;
  private intervalMs: number;
  private retentionMs: number;
  private enabled: boolean;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastScanAt?: string;
  private totalReaped = 0;

  constructor(deps: WorktreeReaperDeps) {
    this.orchestrator = deps.orchestrator;
    this.intervalMs = deps.intervalMs;
    this.retentionMs = deps.retentionMs;
    this.enabled = deps.enabled;
  }

  start(): void {
    if (this.timer) return;
    if (!this.enabled) {
      logger.info('WorktreeReaper disabled (cleanupEnabled=false) — worktrees retained indefinitely');
      return;
    }

    this.timer = setInterval(() => {
      this.reap().catch(err => {
        logger.error('Scheduled worktree reap failed', { error: (err as Error).message });
      });
    }, this.intervalMs);

    logger.info('WorktreeReaper started', { intervalMs: this.intervalMs, retentionMs: this.retentionMs });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('WorktreeReaper stopped');
    }
  }

  async reap(): Promise<WorktreeReapResult> {
    if (!this.enabled || this.running || isShuttingDown()) {
      return { reaped: 0, iids: [] };
    }

    this.running = true;
    const reaped: number[] = [];

    try {
      await this.orchestrator.cleanupExpiredTaskWorkspaces(this.retentionMs);
      const now = Date.now();
      { const orchestrator = this.orchestrator;
        const tracker = orchestrator.getTracker();
        for (const record of tracker.getAll()) {
          if (!this.shouldReap(record, now)) continue;
          const number = getIssueNumber(record);
          try {
            await orchestrator.cleanupCompletedWorktree(number);
            reaped.push(number);
          } catch (err) {
            logger.warn('Failed to reap worktree', { number, error: (err as Error).message });
          }
        }
      }

      if (reaped.length > 0) {
        logger.info('Worktree reap summary', { count: reaped.length, iids: reaped });
      }

      this.lastScanAt = new Date().toISOString();
      this.totalReaped += reaped.length;
    } finally {
      this.running = false;
    }

    return { reaped: reaped.length, iids: reaped };
  }

  getStatus(): WorktreeReaperStatus {
    return {
      running: this.running,
      enabled: this.enabled,
      lastScanAt: this.lastScanAt,
      totalReaped: this.totalReaped,
      intervalMs: this.intervalMs,
      retentionMs: this.retentionMs,
    };
  }

  /** 判定某条记录是否到达回收条件：终态 + 未清理 + 已超过保留期。 */
  private shouldReap(record: IssueRecord, now: number): boolean {
    if (record.run?.recoveryRequired || Object.values(record.run?.calls ?? {}).some(call => call.status !== 'exited')) return false;
    if (record.lifecycle.kind !== 'completed') return false;
    if (record.worktreeCleanedAt) return false;
    if (!record.completedAt) return false;
    const age = now - new Date(record.completedAt).getTime();
    return age >= this.retentionMs;
  }
}
