/**
 * PreviewReaper -- TTL-based automatic stop for preview servers.
 *
 * Periodically scans the tracker for completed/failed issues with expired
 * preview environments and stops their dev servers. Worktrees are preserved
 * so users can restart previews or inspect code until they mark the issue
 * as deployed.
 */
import { logger as rootLogger } from '../logger.js';
import { eventBus as defaultEventBus } from '../events/EventBus.js';
import { isShuttingDown } from '../shutdown/ShutdownSignal.js';
import { getIssueNumber } from '../tracker/IssueRecordHelper.js';
import type { IssueTracker } from '../tracker/IssueTracker.js';
import type { IssueService } from '../orchestrator/IssueService.js';
import type { EventBus } from '../events/EventBus.js';
import { t } from '../i18n/index.js';

const logger = rootLogger.child('PreviewReaper');

export interface PreviewReaperDeps {
  tracker: IssueTracker;
  orchestrator: IssueService;
  intervalMs: number;
  ttlMs: number;
  eventBus?: EventBus;
}

export interface ReapResult {
  reaped: number;
  iids: number[];
}

export interface PreviewReaperStatus {
  running: boolean;
  lastScanAt?: string;
  totalReaped: number;
  intervalMs: number;
  ttlMs: number;
}

export class PreviewReaper {
  private tracker: IssueTracker;
  private orchestrator: IssueService;
  private intervalMs: number;
  private ttlMs: number;
  private bus: EventBus;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastScanAt?: string;
  private totalReaped = 0;

  constructor(deps: PreviewReaperDeps) {
    this.tracker = deps.tracker;
    this.orchestrator = deps.orchestrator;
    this.intervalMs = deps.intervalMs;
    this.ttlMs = deps.ttlMs;
    this.bus = deps.eventBus ?? defaultEventBus;
  }

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.reap().catch(err => {
        logger.error('Scheduled preview reap failed', { error: (err as Error).message });
      });
    }, this.intervalMs);

    logger.info('PreviewReaper started', { intervalMs: this.intervalMs, ttlMs: this.ttlMs });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('PreviewReaper stopped');
    }
  }

  async reap(): Promise<ReapResult> {
    if (this.running || isShuttingDown()) {
      return { reaped: 0, iids: [] };
    }

    this.running = true;
    const reaped: number[] = [];

    try {
      const now = Date.now();
      const records = this.tracker.getAll();

      for (const record of records) {
        if (!['completed', 'failed'].includes(record.lifecycle.kind)) continue;
        if (!record.previewStartedAt) continue;

        const age = now - new Date(record.previewStartedAt).getTime();
        if (age < this.ttlMs) continue;

        const number = getIssueNumber(record);
        const hours = Math.round(age / (60 * 60 * 1000));

        try {
          await this.orchestrator.stopPreviewServers(number);
          reaped.push(number);
          logger.info(t('reaper.reaped', { number, hours }));
        } catch (err) {
          logger.warn('Failed to reap preview', { number, error: (err as Error).message });
        }
      }

      if (reaped.length > 0) {
        logger.info(t('reaper.summary', { count: reaped.length }));
        this.bus.emitTyped('preview:reaped', { iids: reaped, count: reaped.length });
      }

      this.lastScanAt = new Date().toISOString();
      this.totalReaped += reaped.length;
    } finally {
      this.running = false;
    }

    return { reaped: reaped.length, iids: reaped };
  }

  getStatus(): PreviewReaperStatus {
    return {
      running: this.running,
      lastScanAt: this.lastScanAt,
      totalReaped: this.totalReaped,
      intervalMs: this.intervalMs,
      ttlMs: this.ttlMs,
    };
  }
}
