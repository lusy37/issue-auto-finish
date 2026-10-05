import { ISSUE_LABELS } from '../clients/IssueLabels.js';
import { Config } from '../config.js';
import { GitHubClient, GitHubIssue } from '../clients/GitHubClient.js';
import { IssueTracker } from '../tracker/IssueTracker.js';
import type { IssueRecord } from '../tracker/IssueRecord.js';
import type { IssueLifecycle } from '../tracker/IssueLifecycle.js';
import { getIssueNumber } from '../tracker/IssueRecordHelper.js';
import { githubIssueToDemandSpec } from '../demand/adapters/GitHubAdapter.js';
import { IssueService } from '../orchestrator/IssueService.js';
import { isShuttingDown } from '../shutdown/ShutdownSignal.js';
import { logger as rootLogger } from '../logger.js';
import { t } from '../i18n/index.js';
import crypto from 'node:crypto';

const logger = rootLogger.child('IssuePoller');

const AUTO_FINISH_LABEL = ISSUE_LABELS.root;
const AUTO_APPROVE_CHECK_INTERVAL_MS = 30_000;
/** GitHub侧表示「已结束、不应再驱动」的终态标签。 */

export class IssuePoller {
  private config: Config;
  private github: GitHubClient;
  private tracker: IssueTracker;
  private orchestrator: IssueService;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private driveTimer: ReturnType<typeof setInterval> | null = null;
  private activeIssues = new Set<number>();
  private lastAutoApproveCheckMs = 0;
  /** 是否暂停从 GitHub 发现新的 Issue；不影响已有 Issue 的执行。 */
  private discoveryPaused = false;
  /** 是否尚未完成首次成功发现，用于跳过启动前已存在的 Issue。 */
  private isFirstDiscovery = true;
  /** 是否已有一轮 discovery 正在执行，避免发现任务重入。 */
  private discovering = false;

  constructor(
    config: Config,
    github: GitHubClient,
    tracker: IssueTracker,
    orchestrator: IssueService,
  ) {
    this.config = config;
    this.github = github;
    this.tracker = tracker;
    this.orchestrator = orchestrator;
  }

  start(): void {
    const { discoveryIntervalMs, driveIntervalMs } = this.config.poll;
    logger.info('Issue poller starting', { discoveryIntervalMs, driveIntervalMs });

    // 先立即执行一次发现，尽快识别 GitHub 中符合条件的 Issue；驱动执行延迟 5 秒启动。
    // 发现和驱动都会访问 GitHub API，错开启动可以避免初始化阶段集中发起请求。
    // 这样可降低触发 GitHub 速率限制（HTTP 429）的风险，并让首次发现先完成。
    this.safeDiscover();

    const driveStartDelayMs = 5000;
    this.driveTimer = setTimeout(() => {
      this.safeDrive();
      this.driveTimer = setInterval(() => this.safeDrive(), driveIntervalMs);
    }, driveStartDelayMs) as unknown as ReturnType<typeof setInterval>;

    this.discoveryTimer = setInterval(() => this.safeDiscover(), discoveryIntervalMs);
  }

  private safeDiscover(): void {
    this.discover().catch((err) => {
      logger.error('Discovery cycle threw unexpectedly', { error: (err as Error).message });
    });
  }

  private safeDrive(): void {
    try {
      this.drive();
    } catch (err) {
      logger.error('Drive cycle threw unexpectedly, continuing on next tick', {
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
    }
  }

  stop(): void {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    if (this.driveTimer) {
      clearInterval(this.driveTimer);
      this.driveTimer = null;
    }
    logger.info('Issue poller stopped', {});
  }

  getActiveIssueIids(): number[] {
    return [...this.activeIssues];
  }

  getActiveCount(): number {
    return this.activeIssues.size;
  }

  forceReleaseIssue(issueIid: number): boolean {
    const had = this.activeIssues.has(issueIid);
    if (had) {
      this.activeIssues.delete(issueIid);
      logger.info('Force-released issue from activeIssues', { issueIid });
    }
    this.tracker.clearProcessingLock(issueIid);
    return had;
  }

  pauseDiscovery(): void {
    this.discoveryPaused = true;
    logger.info('发现新任务已暂停');
  }

  resumeDiscovery(): void {
    this.discoveryPaused = false;
    logger.info('Discovery resumed');
  }

  /**
   * 执行一次新 Issue 发现：从 GitHub 查询带有自动处理标签的开放 Issue，
   * 过滤已登记或已完成的 Issue，并将新 Issue 转换后写入本地 Tracker。
   * 首次成功发现时，启动前已存在的 Issue 会标记为跳过；后续发现的 Issue 才会进入待处理状态。
   */
  private async discover(): Promise<void> {
    if (isShuttingDown()) return;
    if (this.discoveryPaused) return;
    // 重入保护：上一轮 discovery 未完成（如卡在GitHub 429 退避）时跳过本次 tick，
    // 避免高频 timer 堆叠出多个并发 discovery 形成 API 请求风暴。
    if (this.discovering) return;
    this.discovering = true;
    try {
      logger.debug('Discovering new issues...');
      const issues = await this.github.listIssues('open', AUTO_FINISH_LABEL);
      const newIssues = issues.filter((issue) => this.passesBasicFilter(issue));

      // listIssues + 过滤成功才算「首次发现完成」：存量 issue 已被看到，标志可安全消耗。
      // 必须在用 isFirstDiscovery 计算 initialState 之后再置位。
      // 关键：若本轮抛错（如 429），标志保留，确保后续首个成功发现仍把存量 issue 标记为 skipped。
      const initialLifecycle: IssueLifecycle = this.isFirstDiscovery
        ? { kind: 'skipped' }
        : { kind: 'pending' };
      if (this.isFirstDiscovery) {
        this.isFirstDiscovery = false;
        logger.info('First discovery completed — pre-existing issues marked as skipped');
      }

      if (newIssues.length === 0) {
        logger.debug('No new issues found');
        return;
      }

      logger.info('Discovered new issues', {
        count: newIssues.length,
        initialLifecycle: initialLifecycle.kind,
      });
      for (const issue of newIssues) {
        /** 创建新的 issue 记录 */
        this.tracker.create({
          lifecycle: initialLifecycle,
          branchName: `${this.config.project.branchPrefix}-${issue.number}`,
          demandSpec: githubIssueToDemandSpec(issue),
        });
      }
    } catch (err) {
      logger.error('Discovery cycle failed', { error: (err as Error).message });
    } finally {
      this.discovering = false;
    }
  }

  /**
   * 驱动一轮可执行 Issue：检查关闭状态和并发容量，筛选可恢复或待处理的任务，
   * 获取对应的持久化处理锁后，在后台交给 IssueService 执行；本函数只负责调度，不负责具体阶段逻辑。
   */
  private drive(): void {
    if (isShuttingDown()) return;

    this.maybeAutoApproveWaiting();

    const maxConcurrent = this.config.poll.maxConcurrent;
    const available = maxConcurrent - this.activeIssues.size;
    if (available <= 0) {
      logger.debug('Skipping drive — at concurrency limit', {
        active: this.activeIssues.size,
        max: maxConcurrent,
      });
      return;
    }

    const drivable = this.tracker
      .getDrivableIssues(this.config.poll.maxRetries)
      .filter((r) => !this.activeIssues.has(getIssueNumber(r)));

    if (drivable.length === 0) {
      return;
    }

    const batch = drivable.slice(0, available);
    logger.info('Driving issues', {
      batchSize: batch.length,
      active: this.activeIssues.size,
      max: maxConcurrent,
    });

    for (const record of batch) {
      const number = getIssueNumber(record);
      const correlationId = crypto.randomUUID();

      // 持久化锁：防止同一 issue 被并发处理（activeIssues 之外的第二道防线）。
      // acquireProcessingLock 内部走 tracker.save() — 在 EDQUOT/ENOSPC 时会抛错，
      // 我们只跳过当前 issue 让下个 tick 重试，不影响 batch 中的其他 issue。
      let acquired = false;
      try {
        acquired = this.tracker.acquireProcessingLock(number, correlationId);
      } catch (err) {
        logger.error('acquireProcessingLock threw, skipping issue this tick', {
          issueIid: number,
          error: (err as Error).message,
          code: (err as NodeJS.ErrnoException).code,
        });
        continue;
      }
      if (!acquired) {
        logger.warn('Failed to acquire processing lock, skipping', { issueIid: number });
        continue;
      }

      this.activeIssues.add(number);
      this.processInBackground(record, correlationId);
    }
  }

  private maybeAutoApproveWaiting(): void {
    if (!this.config.review.enabled) return;
    const autoLabels = this.config.review.autoApproveLabels;
    if (!autoLabels.length) return;

    const now = Date.now();
    if (now - this.lastAutoApproveCheckMs < AUTO_APPROVE_CHECK_INTERVAL_MS) return;
    this.lastAutoApproveCheckMs = now;

    const waiting = this.tracker.getAll().filter((r) => {
      const lifecycle = r.lifecycle;
      return lifecycle.kind === 'waiting' && lifecycle.phase === 'review';
    });
    if (!waiting.length) return;

    this.autoApproveByLabels(waiting, autoLabels).catch((err) => {
      logger.warn('Auto-approve check failed', { error: (err as Error).message });
    });
  }

  private async autoApproveByLabels(records: IssueRecord[], autoLabels: string[]): Promise<void> {
    for (const record of records) {
      try {
        const issue = await this.github.getIssueDetail(getIssueNumber(record));
        const matched = issue.labels.filter((l) => autoLabels.includes(l));
        if (matched.length === 0) continue;

        const number = getIssueNumber(record);
        logger.info('Auto-approving waiting issue (label matched)', {
          number,
          matchedLabels: matched,
        });

        // 统一更新编排状态、阶段进度与历史，并发出 review:approved 事件
        await this.orchestrator.applyGateAction(
          number,
          { action: 'approve', source: 'label' },
          record.run.planRevision,
        );

        try {
          await this.github.createIssueNote(
            getIssueNumber(record),
            t('poller.autoApproveComment', { labels: matched.join(', ') }),
          );
        } catch {
          /* ignore */
        }
      } catch (err) {
        logger.warn('Failed to check auto-approve labels', {
          number: getIssueNumber(record),
          error: (err as Error).message,
        });
      }
    }
  }

  private async processInBackground(record: IssueRecord, correlationId: string): Promise<void> {
    const number = getIssueNumber(record);
    try {
      const issue = await this.resolveIssue(getIssueNumber(record));
      if (!issue) {
        logger.warn('Could not resolve issue from API, skipping', { number });
        return;
      }

      await this.orchestrator.processIssue(issue);
    } catch (err) {
      logger.error('Failed to process issue', {
        number,
        error: (err as Error).message,
      });
    } finally {
      this.activeIssues.delete(number);
      this.tracker.releaseProcessingLock(number, correlationId);
    }
  }

  private async resolveIssue(issueId: number): Promise<GitHubIssue | null> {
    try {
      return await this.github.getIssueDetail(issueId);
    } catch {
      return null;
    }
  }

  private passesBasicFilter(issue: GitHubIssue): boolean {
    if (!issue.labels.includes(AUTO_FINISH_LABEL)) return false;
    if (issue.labels.some((l) => l === ISSUE_LABELS.done)) return false;
    if (this.tracker.get(issue.number)) return false;

    return true;
  }
}
