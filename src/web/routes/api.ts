import { renderPlan } from '../../dag/contracts.js';
import { resolveDataDir } from '../../paths.js';
import { githubIssueToDemandSpec } from '../../demand/adapters/GitHubAdapter.js';
import express, { type Request, type Response } from 'express';
const { Router } = express;
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { createPatch } from 'diff';
import { IssueTracker } from '../../tracker/IssueTracker.js';
import { IssueState, type IssueRecord } from '../../tracker/IssueState.js';
import { readIssueLifecycle } from '../../tracker/IssueLifecycle.js';
import { issueStateCategory } from '../../tracker/ExecutableTask.js';
import type { DemandSpec } from '../../demand/DemandSpec.js';
import { getIssueNumber, getTitle } from '../../tracker/IssueRecordHelper.js';
import { Config } from '../../config.js';
import { AgentLogStore } from '../AgentLogStore.js';
import { IssueService } from '../../orchestrator/IssueService.js';
import { GitOperations } from '../../git/GitOperations.js';
import { GitHubClient } from '../../clients/GitHubClient.js';
import { SupplementStore } from '../../supplement/SupplementStore.js';
import { buildPlanModePipeline, getPipelineDef, getAllPipelineDefs, createLifecycleManager } from '../../pipeline/PipelineMetadata.js';
import type { PipelineDef } from '../../pipeline/PipelineMetadata.js';
import { ActionLifecycleManager } from '../../lifecycle/ActionLifecycleManager.js';
import { eventBus, EventPayload } from '../../events/EventBus.js';
import { GateActionError } from '../../orchestration/index.js';
import { getNoteSyncEnabled, setNoteSyncOverride } from '../../notesync/NoteSyncSettings.js';
import { getE2eEnabled, isE2eEnabledForIssue } from '../../e2e/E2eSettings.js';

import type { WorkspaceConfig } from '../../workspace/WorkspaceConfig.js';
import { logger as rootLogger } from '../../logger.js';
import { t } from '../../i18n/index.js';
import type { IssuePoller } from '../../poller/IssuePoller.js';
import type { DistillScheduler } from '../../distill/DistillScheduler.js';
import type { DiaryCollector } from '../../distill/DiaryCollector.js';
import type { PreviewReaper } from '../../preview/PreviewReaper.js';
import type { WorktreeReaper } from '../../workspace/WorktreeReaper.js';

const logger = rootLogger.child('ApiRoutes');

/** Stream event types filtered from the SSE stream (protocol-level metadata with no user-facing value). */
const DEBUG_SSE_EVENT_TYPES = new Set([
  'thinking', 'content_block_start', 'content_block_delta',
  'content_block_stop', 'message_start', 'message_delta',
  'message_stop', 'ping',
  'message', // 顶级消息框架 - 含 uuid/session_id 等协议元数据
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readPackageVersion(): string {
  try {
    for (let dir = __dirname; dir !== path.dirname(dir); dir = path.dirname(dir)) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        const content = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        if (content.name === 'issue-auto-finish') {
          return content.version;
        }
      }
    }
  } catch { /* ignore */ }
  return 'unknown';
}

const startTime = Date.now();
const pkgVersion = readPackageVersion();

export interface ApiRouterDeps {
  tracker: IssueTracker;
  config: Config;
  agentLogStore: AgentLogStore;
  orchestrator: IssueService;
  github: GitHubClient;
  supplementStore: SupplementStore;
  mainGit?: GitOperations;
  poller?: IssuePoller;
  distillScheduler?: DistillScheduler;
  diaryCollector?: DiaryCollector;
  wsConfig?: WorkspaceConfig;
  previewReaper?: PreviewReaper;
  worktreeReaper?: WorktreeReaper;
}

function buildPreviewInfo(number: number, orch: IssueService) {
  const ports = orch.getPortAllocator().getPortsForIssue(number);
  if (!ports) return null;
  const dsm = orch.getDevServerManager();
  const status = dsm.getStatus(number);
  return {
    ...status,
    ports,
    previewUrl: orch.buildPreviewUrl(number),
    host: orch.getPreviewHost(),
  };
}

export function createApiRouter(deps: ApiRouterDeps): ReturnType<typeof Router> {
  const { tracker, config: cfg, agentLogStore: logStore, orchestrator: orch, mainGit: git, github, supplementStore, poller, previewReaper, worktreeReaper } = deps;
  const router = Router();
  // 在首次异步请求前占用编号，防止并发启动覆盖同一个任务。
  const startingIssues = new Set<number>();

  router.get('/api/pipeline-meta', (_req: Request, res: Response) => {
    const allDefs = getAllPipelineDefs();
    const allLMs = allDefs.map(def => ({ def, lm: createLifecycleManager(def) }));

    const modes: Record<string, unknown> = {};
    const phaseStatuses: Record<string, Record<string, Record<string, string>>> = {};
    for (const { def, lm } of allLMs) {
      modes[def.mode] = {
        phases: def.phases.map(p => ({ name: p.name, label: p.label, kind: p.kind })),
        artifacts: lm.collectArtifacts().map(a => ({
          filename: a.filename, label: a.label, editable: a.editable,
        })),
        retryablePhases: lm.getRetryablePhases(),
      };
      phaseStatuses[def.mode] = buildPhaseStatusMap(def, lm);
    }

    res.json({
      modes,
      stateLabels: Object.fromEntries(new Map(
        allLMs.flatMap(({ lm }) => [...lm.collectStateLabels()]),
      )),
      phaseStatuses,
      stateCategories: buildStateCategoryMap(allLMs.map(({ lm }) => lm)),
    });
  });

  router.get('/api/e2e-test-route', (_req: Request, res: Response) => {
    res.json({ ok: true, ts: Date.now() });
  });

  router.get('/api/tasks', (_req, res) => res.json(tracker.toExecutableTasks()));

  router.get('/api/issues', (_req: Request, res: Response) => {
    const issues = tracker.getAll();
    const enriched = issues.map(r => {
      const stateCategory = issueStateCategory(r);
      return { ...r, stateCategory, planDocs: getIssuePlanDocs(getIssueNumber(r), r) };
    });
    res.json(enriched);
  });

  router.get('/api/issues/:number', async (req: Request, res: Response) => {
    const number = parseInt(req.params.number, 10);
    const record = tracker.get(number);
    if (!record) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }

    const progress = record.phaseProgress
      ? { phases: record.phaseProgress, currentPhase: record.currentPhase }
      : await readProgress(number, cfg, tracker, git);
    const preview = buildPreviewInfo(number, orch);
    const worktree = orch.getWorktreeStatus(number);
    res.json({ ...record, progress, preview, worktree, planDocs: getIssuePlanDocs(number, record) });
  });

  function getIssuePipelineDef(number: number, record: IssueRecord | undefined = tracker.get(number)): PipelineDef {
    const mode = record?.pipelineMode ?? orch.getPipelineDef().mode;
    return mode === 'plan-mode'
      ? buildPlanModePipeline({ e2eEnabled: isE2eEnabledForIssue(number, tracker, cfg) })
      : getPipelineDef(mode);
  }

  function getIssuePlanDocs(number: number, record: IssueRecord | undefined = tracker.get(number)) {
    return createLifecycleManager(getIssuePipelineDef(number, record)).collectArtifacts()
      .map(artifact => ({ file: artifact.filename, label: artifact.label }));
  }

  router.get('/api/issues/:number/plans/:filename', async (req: Request, res: Response) => {
    const number = parseInt(req.params.number, 10);
    const filename = req.params.filename;
    const def = getIssuePipelineDef(number);
    const lm = createLifecycleManager(def);
    const allowed = [
      ...lm.collectArtifacts().map(f => f.filename),
      'progress.json', 'issue-meta.json',
    ];
    if (!allowed.includes(filename)) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }
    const content = await readPlanFile(number, filename, cfg, tracker, git);
    if (content === null) {
      res.status(404).json({ error: 'Plan file not found' });
      return;
    }
    if (filename.endsWith('.json')) {
      if (req.query.format === 'html') {
        const html = await marked('```json\n' + JSON.stringify(JSON.parse(content), null, 2) + '\n```');
        res.type('html').send(html);
        return;
      }
      res.json(JSON.parse(content));
      return;
    }
    if (req.query.format === 'html') {
      const html = await marked(content);
      res.type('html').send(html);
      return;
    }
    res.type('text/markdown').send(content);
  });

  router.post('/api/issues/:number/start', (req: Request, res: Response) => {
    const number = parseInt(req.params.number, 10);
    const ok = tracker.startSkipped(number);
    if (!ok) {
      res.status(400).json({ error: 'Issue is not in skipped state or not found' });
      return;
    }
    res.json({ success: true, message: `Issue #${number} started` });
  });

  const persistedControl = (number: number) => {
    const record = tracker.get(number);
    return record && { state: record.state, version: record.run?.version, stopIntent: record.run?.stopIntent ?? null, planRevision: record.run?.planRevision, buildGeneration: record.run?.buildGeneration };
  };

  router.post('/api/issues/:number/retry', (req: Request, res: Response) => {
    const number = parseInt(req.params.number, 10);
    if (Object.values(tracker.get(number)?.run?.calls ?? {}).some(call => call.status !== 'exited')) { res.status(409).json({ error: '旧调用尚未确认退出，请先中止并核对进程' }); return; }
    let ok: boolean;
    try { ok = orch.retryIssue(number); }
    catch (error) { res.status(409).json({ error: (error as Error).message }); return; }
    if (!ok) {
      res.status(400).json({ error: 'Issue is not in failed state or not found' });
      return;
    }
    res.json({ success: true, control: persistedControl(number), message: `Issue #${number} reset for retry` });
  });

  router.post('/api/issues/:number/cancel', async (req: Request, res: Response) => {
    const number = parseInt(req.params.number, 10);
    const record = tracker.get(number);
    if (!record) {
      res.status(404).json({ error: 'Issue not found in tracker' });
      return;
    }

    try {

      // 停止意图落盘且进程退出后，才释放父 Issue 额度。
      await orch.cancelIssue(number);
      poller?.forceReleaseIssue(number);

      res.json({ success: true, control: persistedControl(number), message: `Issue #${number} cancelled` });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post('/api/issues/:number/restart', async (req: Request, res: Response) => {
    const number = parseInt(req.params.number, 10);
    try {

      await orch.restartIssue(number);
      // 必须在 restartIssue 完成后再释放，否则 drive() 会在清理期间重新拾取 issue
      poller?.forceReleaseIssue(number);
      res.json({ success: true, control: persistedControl(number), message: `Issue #${number} restarted` });
    } catch (err) {
      const msg = (err as Error).message;
      logger.error('Restart failed', { number, error: msg });
      res.status(400).json({ error: msg });
    }
  });

  router.post('/api/issues/:number/retry-from-phase', (req: Request, res: Response) => {
    const number = parseInt(req.params.number, 10);
    const { phase } = req.body as { phase?: string };
    const def = getIssuePipelineDef(number);
    const lm = createLifecycleManager(def);
    const validPhases = lm.getRetryablePhases();
    if (!phase || !validPhases.includes(phase)) {
      res.status(400).json({ error: `Invalid phase. Must be one of: ${validPhases.join(', ')}` });
      return;
    }
    try {
      orch.retryFromPhase(number, phase);
      poller?.forceReleaseIssue(number);
      res.json({ success: true, control: persistedControl(number), message: `Issue #${number} reset to phase: ${phase}` });
    } catch (err) {
      const msg = (err as Error).message;
      logger.error('Retry-from-phase failed', { number, phase, error: msg });
      res.status(400).json({ error: msg });
    }
  });

  // ── 阶段级中止/继续/重做 ──

  router.post('/api/issues/:number/abort', async (req: Request, res: Response) => {
    const number = parseInt(req.params.number, 10);
    try {
      await orch.abortIssue(number);
      poller?.forceReleaseIssue(number);
      res.json({ success: true, control: persistedControl(number), message: `Issue #${number} aborted` });
    } catch (err) {
      const msg = (err as Error).message;
      logger.error('Abort failed', { number, error: msg });
      res.status(400).json({ error: msg });
    }
  });

  router.post('/api/issues/:number/continue', (req: Request, res: Response) => {
    const number = parseInt(req.params.number, 10);
    try {
      orch.continueIssue(number);
      res.json({ success: true, control: persistedControl(number), message: `Issue #${number} continued` });
    } catch (err) {
      const msg = (err as Error).message;
      logger.error('Continue failed', { number, error: msg });
      res.status(400).json({ error: msg });
    }
  });

  router.post('/api/issues/:number/redo-phase', async (req: Request, res: Response) => {
    const number = parseInt(req.params.number, 10);
    try {
      await orch.redoPhase(number);
      poller?.forceReleaseIssue(number);
      res.json({ success: true, control: persistedControl(number), message: `Issue #${number} phase redone` });
    } catch (err) {
      const msg = (err as Error).message;
      logger.error('Redo-phase failed', { number, error: msg });
      res.status(400).json({ error: msg });
    }
  });

  router.put('/api/issues/:number/plans/:filename', (req: Request, res: Response) => {
    const number = parseInt(req.params.number, 10);
    const filename = req.params.filename;
    if (filename === '01-plan.md') { res.status(403).json({ error: '计划由结构化版本生成，只能通过审核反馈重新规划' }); return; }
    const def = getIssuePipelineDef(number);
    const lm = createLifecycleManager(def);
    const editableFiles = lm.collectArtifacts().filter(f => f.editable).map(f => f.filename);
    if (!editableFiles.includes(filename)) {
      res.status(400).json({ error: `File not editable. Allowed: ${editableFiles.join(', ')}` });
      return;
    }
    const { content } = req.body as { content?: string };
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'Request body must contain a "content" string field' });
      return;
    }
    const planDir = getWorktreePlanDir(number, cfg);
    const filePath = path.join(planDir, filename);
    if (!fs.existsSync(planDir)) {
      res.status(404).json({ error: 'Plan directory not found (worktree may have been cleaned)' });
      return;
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    logger.info('Plan file updated', { number, filename });
    res.json({ success: true, message: `Plan file ${filename} saved` });
  });

  router.get('/api/issues/:number/tasks', (req: Request, res: Response) => {
    const number = Number(req.params.number);
    const record = tracker.get(number);
    if (!record) { res.status(404).json({ error: 'Issue 不存在' }); return; }
    const run = record.run!;
    const plan = run.planRevision && run.planDigest ? tracker.store.readPlan(number, run.planRevision, run.planDigest) : undefined;
    res.json({ planRevision: run.planRevision, buildGeneration: run.buildGeneration, control: run.stopIntent, tasks: plan?.tasks.map(task => ({ ...task, ...run.tasks[task.id] })) ?? [] });
  });

  router.get('/api/issues/:number/logs', (req: Request, res: Response) => {
    const number = parseInt(req.params.number, 10);
    const record = tracker.get(number);
    if (!record) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }
    const logs = logStore.getLogs(number).filter(entry => (!req.query.taskId || entry.identity?.taskId === req.query.taskId) && (!req.query.attemptNo || entry.identity?.attemptNo === Number(req.query.attemptNo)));
    res.json(logs);
  });

  // --- Supplement endpoints ---

  router.get('/api/issues/:number/supplement', (req: Request, res: Response) => {
    if (!supplementStore) {
      res.status(501).json({ error: 'Supplement store not available' });
      return;
    }
    const number = parseInt(req.params.number, 10);
    const info = supplementStore.get(number);
    res.json(info);
  });

  router.put('/api/issues/:number/supplement', (req: Request, res: Response) => {
    if (!supplementStore) {
      res.status(501).json({ error: 'Supplement store not available' });
      return;
    }
    const number = parseInt(req.params.number, 10);
    const body = req.body as Record<string, unknown>;
    const data = {
      requirements: String(body.requirements || ''),
      acceptanceCriteria: String(body.acceptanceCriteria || ''),
      scope: String(body.scope || ''),
      constraints: String(body.constraints || ''),
      references: String(body.references || ''),
      freeText: String(body.freeText || ''),
    };
    const saved = supplementStore.save(number, data);
    res.json({ success: true, data: saved });
  });

  // --- GitHub issue browsing ---

  router.get('/api/github/issues', async (req: Request, res: Response) => {
    if (!github) {
      res.status(501).json({ error: 'GitHub client not available' });
      return;
    }
    try {
      const search = (req.query.search as string) || '';
      const page = parseInt(req.query.page as string, 10) || 1;
      const perPage = parseInt(req.query.per_page as string, 10) || 20;

      const result = await github.listIssuesAdvanced({
        state: 'open',
        search: search || undefined,
        page,
        perPage,
      });

      const trackedIids = new Set(tracker.getAll().map((r) => getIssueNumber(r)));

      res.json({
        issues: result.issues,
        total: result.total,
        trackedIids: Array.from(trackedIids),
      });
    } catch (err) {
      const msg = (err as Error).message;
      logger.error('Failed to fetch github issues', { error: msg });
      res.status(500).json({ error: msg });
    }
  });

  // --- Start processing an issue ---

  router.post('/api/issues/start', async (req: Request, res: Response) => {
    if (!github) {
      res.status(501).json({ error: 'GitHub client not available' });
      return;
    }
    const body = req.body as {
      issueId?: number;
      issueIid?: number;
      issueTitle?: string;
      supplement?: Record<string, string>;
    };
    if (typeof body.issueIid !== 'number' || !Number.isSafeInteger(body.issueIid) || body.issueIid < 1) {
      res.status(400).json({ error: '需要正整数 Issue 编号 issueIid' });
      return;
    }

    const existing = tracker.get(body.issueIid);
    if (existing || startingIssues.has(body.issueIid)) {
      res.status(409).json({ error: `Issue #${body.issueIid} is already being tracked` });
      return;
    }

    startingIssues.add(body.issueIid);
    try {
      let demandSpec: DemandSpec;
      try { demandSpec = githubIssueToDemandSpec(await github.getIssueDetail(body.issueIid)); }
      catch (error) { res.status(400).json({ error: (error as Error).message }); return; }

      try {
        await github.addLabel(body.issueIid, 'auto-finish');
      } catch (err) {
        logger.warn('Failed to add auto-finish label', { error: (err as Error).message });
      }

      const branchName = `${cfg.project.branchPrefix}-${body.issueIid}`;
      const record = tracker.create({
        state: IssueState.Pending,
        branchName,
        demandSpec,
      });

      if (supplementStore && body.supplement) {
        supplementStore.save(body.issueIid, {
          requirements: String(body.supplement.requirements || ''),
          acceptanceCriteria: String(body.supplement.acceptanceCriteria || ''),
          scope: String(body.supplement.scope || ''),
          constraints: String(body.supplement.constraints || ''),
          references: String(body.supplement.references || ''),
          freeText: String(body.supplement.freeText || ''),
        });
      }

      res.json({ success: true, record });
    } finally {
      startingIssues.delete(body.issueIid);
    }
  });

  // --- Review Gate endpoints ---

  router.post('/api/issues/:number/approve-plan', async (req: Request, res: Response) => {
    const revisionRecord = tracker.get(Number(req.params.number));
    if (!Number.isInteger(req.body?.planRevision) || req.body.planRevision !== revisionRecord?.run?.planRevision) { res.status(409).json({ error: '审核版本已过期或缺失，请刷新计划后重试' }); return; }
    const number = parseInt(req.params.number, 10);
    const record = tracker.get(number);
    if (!record) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }
    const lifecycle = readIssueLifecycle(record);
    if (lifecycle.kind !== 'waiting') {
      res.status(400).json({ error: `Issue is not waiting for review (current state: ${record.state})` });
      return;
    }

    // 审核入口只处理当前流水线的审核阶段，避免覆盖其他阶段。
    const def = getIssuePipelineDef(number);
    const lm = createLifecycleManager(def);
    const gateSpec = lm.getGatePhase();
    if (!gateSpec) {
      res.status(400).json({ error: 'Pipeline has no gate phase' });
      return;
    }
    if (lifecycle.phase !== gateSpec.name) {
      res.status(400).json({
        error: `approve-plan only applies to the ${gateSpec.name} gate phase, but issue is currently at ${record.currentPhase ?? 'unknown'} gate. Use phase-specific approval instead.`,
      });
      return;
    }
    try {
      await orch.applyGateAction(number, { action: 'approve' }, req.body.planRevision);
      logger.info('Plan approved', { number });
      res.json({ success: true, message: `Issue #${number} plan approved, will resume on next drive cycle` });
    } catch (err) {
      if (err instanceof GateActionError) {
        res.status(409).json({ error: err.message });
        return;
      }
      const e = err as NodeJS.ErrnoException;
      logger.error('Failed to approve plan', { number, code: e.code, error: e.message });
      res.status(500).json({
        error: `Failed to approve plan: ${e.message}`,
        code: e.code,
      });
    }
  });

  router.post('/api/issues/:number/reject-plan', async (req: Request, res: Response) => {
    const revisionRecord = tracker.get(Number(req.params.number));
    if (!Number.isInteger(req.body?.planRevision) || req.body.planRevision !== revisionRecord?.run?.planRevision) { res.status(409).json({ error: '审核版本已过期或缺失，请刷新计划后重试' }); return; }
    const number = parseInt(req.params.number, 10);
    const record = tracker.get(number);
    if (!record) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }
    const lifecycle = readIssueLifecycle(record);
    if (lifecycle.kind !== 'waiting') {
      res.status(400).json({ error: `Issue is not waiting for review (current state: ${record.state})` });
      return;
    }
    const { feedback } = req.body as { feedback?: string };
    if (!feedback || typeof feedback !== 'string') {
      res.status(400).json({ error: 'Feedback is required' });
      return;
    }
    // 严格校验 currentPhase 与 gate phase 一致：reject 语义只对 review gate 有意义（驳回后重新规划）。

    // 抛 GateActionError('reject-not-allowed')，这里翻译为 409。
    const def = getIssuePipelineDef(number);
    const lm = createLifecycleManager(def);
    const gateSpec = lm.getGatePhase();
    if (!gateSpec) {
      res.status(400).json({ error: 'Pipeline has no gate phase' });
      return;
    }
    if (lifecycle.phase !== gateSpec.name) {
      res.status(400).json({
        error: `reject-plan only applies to the ${gateSpec.name} gate phase, but issue is currently at ${record.currentPhase ?? 'unknown'} gate.`,
      });
      return;
    }
    try {
      await orch.applyGateAction(number, { action: 'reject', feedback }, req.body.planRevision);
      logger.info('Plan rejected', { number, feedback: feedback.slice(0, 100) });
      res.json({ success: true, message: `Issue #${number} plan rejected, will re-plan on next drive cycle` });
    } catch (err) {
      if (err instanceof GateActionError) {
        res.status(409).json({ error: err.message });
        return;
      }
      const e = err as NodeJS.ErrnoException;
      logger.error('Failed to reject plan', { number, code: e.code, error: e.message });
      res.status(500).json({
        error: `Failed to reject plan: ${e.message}`,
        code: e.code,
      });
    }
  });

  router.post('/api/issues/:number/skip-review', async (req: Request, res: Response) => {
    const revisionRecord = tracker.get(Number(req.params.number));
    if (!Number.isInteger(req.body?.planRevision) || req.body.planRevision !== revisionRecord?.run?.planRevision) { res.status(409).json({ error: '审核版本已过期或缺失，请刷新计划后重试' }); return; }
    const number = parseInt(req.params.number, 10);
    const record = tracker.get(number);
    if (!record) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }
    const lifecycle = readIssueLifecycle(record);
    if (lifecycle.kind !== 'waiting') {
      res.status(400).json({ error: `Issue is not waiting for review (current state: ${record.state})` });
      return;
    }
    // skip-review 与 approve-plan 等价（都是把 gate 标记为通过），同样严格校验 currentPhase。
    const def = getIssuePipelineDef(number);
    const lm = createLifecycleManager(def);
    const gateSpec = lm.getGatePhase();
    if (!gateSpec) {
      res.status(400).json({ error: 'Pipeline has no gate phase' });
      return;
    }
    if (lifecycle.phase !== gateSpec.name) {
      res.status(400).json({
        error: `skip-review only applies to the ${gateSpec.name} gate phase, but issue is currently at ${record.currentPhase ?? 'unknown'} gate.`,
      });
      return;
    }
    try {
      await orch.applyGateAction(number, { action: 'approve' }, req.body.planRevision);
      logger.info('Review skipped', { number });
      res.json({ success: true, message: `Issue #${number} review skipped` });
    } catch (err) {
      if (err instanceof GateActionError) {
        res.status(409).json({ error: err.message });
        return;
      }
      const e = err as Error;
      logger.error('Failed to skip review', { number, error: e.message });
      res.status(500).json({ error: `Failed to skip review: ${e.message}` });
    }
  });

  router.get('/api/issues/:number/review-history', (req: Request, res: Response) => {
    const number = parseInt(req.params.number, 10);
    const record = tracker.get(number);
    if (!record) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }
    res.json(loadReviewHistory(number, tracker));
  });

  /**
   * 对比 worktree 中 plan 文档当前版本 vs 最近一轮被驳回时的 planSnapshot，
   * 返回 unified diff 供前端审核页"本轮改进对比"区域展示。
   *
   * 历史方案用 git HEAD 作基线，但因为 worktree 与主仓库共享 .git 目录，
   * 一旦本轮 plan commit 完成 HEAD 立刻同步到本轮版本，diff 会反而归零；
   * 而新一轮 plan 还在 AI 写入过程中时，diff 又会显示半成品脏内容。
   * 现改为以 review-history.json 中最近一轮的 planSnapshot 作为基线，
   * 语义是"本轮 vs 上轮被驳回时"，与 UI 文案一致且时序稳定。
   *
   * 查询参数：
   *   file (可选，默认 01-plan.md。当前仅 01-plan.md 有快照，其他文件返回 hasChanges=false)
   *
   * 响应：{ diff: string; hasChanges: boolean }
   *   - hasChanges=false：首轮（无 history）/ snapshot 缺失 / 内容相同 / 文件缺失
   */
  router.get('/api/issues/:number/plan-diff', (req: Request, res: Response) => {
    const number = parseInt(req.params.number, 10);
    const record = tracker.get(number);
    if (!record) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }

    const filename = typeof req.query.file === 'string' && req.query.file.trim()
      ? req.query.file.trim()
      : '01-plan.md';
    if (!/^[\w.-]+$/.test(filename)) {
      res.status(400).json({ error: 'Invalid file name' });
      return;
    }

    const currentContent = filename === '01-plan.md' && record.run?.planRevision
      ? renderPlan(tracker.store.readPlan(number, record.run.planRevision, record.run.planDigest)) : null;
    const history = record.run?.reviewHistory ?? [];
    const lastRound = history.length > 0 ? history[history.length - 1] : null;
    const baselineSnapshot = lastRound?.planSnapshot ?? null;

    if (currentContent === null || baselineSnapshot === null) {
      res.json({ diff: '', hasChanges: false });
      return;
    }
    if (currentContent === baselineSnapshot) {
      res.json({ diff: '', hasChanges: false });
      return;
    }

    const diff = createPatch(
      filename,
      baselineSnapshot,
      currentContent,
      `round-${lastRound!.round}`,
      'current',
    );
    res.json({ diff, hasChanges: true });
  });

  // --- Agent interactive dialog response ---




  // --- Note Sync toggle endpoints ---

  router.put('/api/issues/:number/note-sync', (req: Request, res: Response) => {
    const number = parseInt(req.params.number, 10);
    const record = tracker.get(number);
    if (!record) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }
    const { enabled } = req.body as { enabled?: boolean | null };
    const value = enabled === null ? undefined : enabled;
    tracker.updateState(number, record.state, { issueNoteSyncEnabled: value });
    logger.info('Issue note-sync toggled', { number, enabled: value });
    res.json({ success: true, issueNoteSyncEnabled: value ?? null });
  });

  router.put('/api/system/note-sync', (req: Request, res: Response) => {
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    setNoteSyncOverride(enabled);
    logger.info('System note-sync toggled', { enabled });
    res.json({ success: true, issueNoteSyncEnabled: enabled });
  });

  // --- Preview endpoints ---

  router.get('/api/issues/:number/preview', (req: Request, res: Response) => {
    const number = parseInt(req.params.number, 10);
    const record = tracker.get(number);
    if (!record) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }
    const preview = buildPreviewInfo(number, orch);
    res.json(preview ?? { running: false });
  });

  router.post('/api/issues/:number/stop-preview', async (_req: Request, res: Response) => {
    const number = parseInt(_req.params.number, 10);
    const record = tracker.get(number);
    if (!record) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }
    await orch.stopPreviewServers(number);
    res.json({ success: true });
  });

  router.post('/api/issues/:number/restart-preview', async (req: Request, res: Response) => {
    const number = parseInt(req.params.number, 10);
    try {
      const previewUrl = await orch.restartPreview(number);
      res.json({ success: true, previewUrl });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post('/api/issues/:number/rebuild-worktree', async (req: Request, res: Response) => {
    const number = parseInt(req.params.number, 10);
    try {
      await orch.rebuildWorktree(number);
      res.json({ success: true, worktree: orch.getWorktreeStatus(number) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.get('/api/issues/:number/preview-logs/:type', (req: Request, res: Response) => {
    const number = parseInt(req.params.number, 10);
    const logType = req.params.type;
    if (logType !== 'backend' && logType !== 'frontend') {
      res.status(400).json({ error: 'type must be "backend" or "frontend"' });
      return;
    }
    const logPath = orch.getDevServerManager().getLogPath(number, logType);
    if (!logPath) {
      res.status(404).json({ error: 'Log file not found' });
      return;
    }
    const tail = parseInt(req.query.tail as string, 10);
    if (tail > 0) {
      const content = fs.readFileSync(logPath, 'utf-8');
      const lines = content.split('\n');
      // 保留末尾可能的空行
      const start = Math.max(0, lines.length - tail);
      res.type('text/plain').send(lines.slice(start).join('\n'));
      return;
    }
    res.type('text/plain').sendFile(logPath);
  });

  router.get('/api/preview-reaper/status', (_req: Request, res: Response) => {
    if (!previewReaper) {
      res.json({ enabled: false });
      return;
    }
    res.json({ enabled: true, ...previewReaper.getStatus() });
  });

  router.get('/api/worktree-reaper/status', (_req: Request, res: Response) => {
    if (!worktreeReaper) {
      res.json({ enabled: false });
      return;
    }
    res.json(worktreeReaper.getStatus());
  });

  router.get('/api/system/status', (_req: Request, res: Response) => {
    const runningPreviews = orch.getDevServerManager().getRunningIssues();
    const allIssues = tracker.getAll();
    const failedCount = allIssues.filter(r => readIssueLifecycle(r).kind === 'failed').length;
    res.json({
      uptime: Date.now() - startTime,
      startedAt: new Date(startTime).toISOString(),
      pid: process.pid,
      version: pkgVersion,
      config: {
        discoveryIntervalMs: cfg.poll.discoveryIntervalMs,
        driveIntervalMs: cfg.poll.driveIntervalMs,
        maxRetries: cfg.poll.maxRetries,
        maxConcurrent: cfg.poll.maxConcurrent,
        aiMode: cfg.ai.mode,
        aiModel: cfg.ai.model,
        pipelineMode: orch.getPipelineDef().mode,
        baseBranch: cfg.project.baseBranch,
        repository: cfg.github.repository,
        githubBaseUrl: github.webBaseUrl,
        webHost: cfg.web.host,
        webPort: cfg.web.port,
        issueNoteSyncEnabled: getNoteSyncEnabled(cfg),
        e2eEnabled: getE2eEnabled(cfg),
        previewEnabled: cfg.preview.enabled,
        worktreeCleanupEnabled: cfg.worktree.cleanupEnabled,
        worktreeRetentionMs: cfg.worktree.retentionMs,
        locale: cfg.locale,
        knowledgeEnabled: cfg.knowledge.enabled,
        distillEnabled: cfg.distill.enabled,
        reviewEnabled: cfg.review.enabled,
        verifyFixLoopEnabled: cfg.verifyFixLoop.enabled,
        verifyFixMaxIterations: cfg.verifyFixLoop.maxIterations,
      },
      issues: {
        total: allIssues.length,
        active: tracker.getAllActive().length,
        failed: failedCount,
      },
      preview: {
        runningCount: runningPreviews.length,
        runningIssues: runningPreviews,
      },
      worktreeReaper: worktreeReaper?.getStatus() ?? null,
    });
  });

  router.post('/api/system/shutdown', (_req: Request, res: Response) => {
    res.json({ success: true, message: 'Shutdown initiated' });
    // Delay to allow the response to be sent
    setTimeout(() => {
      logger.info('Shutdown requested via API');
      process.kill(process.pid, 'SIGTERM');
    }, 200);
  });

  router.get('/api/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const heartbeat = setInterval(() => {
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);
    }, 15_000);

    const handler = (_eventName: string | symbol, payload: EventPayload) => {
      try {
        // Filter debug-level stream events from agent output to reduce SSE noise
        if (payload.type === 'agent:output') {
          const d = payload.data as { event?: { type?: string } };
          if (d?.event?.type && DEBUG_SSE_EVENT_TYPES.has(d.event.type)) return;
        }
        res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch {
        logger.warn('Failed to write SSE event');
      }
    };

    eventBus.on('*', handler);
    res.write(`event: connected\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);

    req.on('close', () => {
      clearInterval(heartbeat);
      eventBus.off('*', handler);
    });
  });

  // --- Standalone document viewer (linked from issue notes) ---

  router.get('/doc/:number/:filename', async (req: Request, res: Response) => {
    const number = parseInt(req.params.number, 10);
    const filename = req.params.filename;
    const record = tracker.get(number);
    const title = record ? getTitle(record) : `Issue #${number}`;

    const def = getIssuePipelineDef(number);
    const lm = createLifecycleManager(def);
    const allowed = lm.collectArtifacts().map(f => f.filename);
    if (!allowed.includes(filename)) {
      res.status(400).type('html').send(renderDocPage(number, title, t('api.invalidFilename'), filename));
      return;
    }

    const content = await readPlanFile(number, filename, cfg, tracker, git);
    if (content === null) {
      res.status(404).type('html').send(renderDocPage(number, title, t('api.docNotGenerated'), filename));
      return;
    }

    const htmlBody = await marked(content);
    res.type('html').send(renderDocPage(number, title, htmlBody, filename));
  });

  // -----------------------------------------------------------------------
  return router;
}

const DOC_LABELS_FUNC = (filename: string): string => t(`docLabel.${filename}`) || filename;

function renderDocPage(number: number, issueTitle: string, htmlBody: string, filename: string): string {
  const docLabel = DOC_LABELS_FUNC(filename);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Issue #${number} — ${docLabel}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; margin: 0; padding: 0; color: #24292f; background: #f6f8fa; }
  .header { background: #fff; border-bottom: 1px solid #d0d7de; padding: 12px 24px; display: flex; align-items: center; gap: 12px; }
  .header .crumb { font-size: 14px; color: #57606a; }
  .header .crumb a { color: #0969da; text-decoration: none; }
  .header .crumb a:hover { text-decoration: underline; }
  .header .crumb .sep { margin: 0 4px; color: #8b949e; }
  .container { max-width: 900px; margin: 24px auto; background: #fff; border: 1px solid #d0d7de; border-radius: 6px; padding: 32px 40px; }
  .markdown-body h1 { font-size: 1.6em; border-bottom: 1px solid #d0d7de; padding-bottom: .3em; }
  .markdown-body h2 { font-size: 1.3em; border-bottom: 1px solid #d0d7de; padding-bottom: .3em; }
  .markdown-body h3 { font-size: 1.1em; }
  .markdown-body pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 16px; overflow-x: auto; }
  .markdown-body code { background: #f6f8fa; border-radius: 3px; padding: 0.2em 0.4em; font-size: 85%; }
  .markdown-body pre code { background: none; padding: 0; }
  .markdown-body table { border-collapse: collapse; width: 100%; }
  .markdown-body th, .markdown-body td { border: 1px solid #d0d7de; padding: 6px 13px; }
  .markdown-body th { background: #f6f8fa; }
  .markdown-body blockquote { margin: 0; padding: 0 1em; color: #57606a; border-left: 3px solid #d0d7de; }
  .markdown-body ul, .markdown-body ol { padding-left: 2em; }
  .markdown-body li { margin-top: 0.25em; }
  .markdown-body p { margin: 8px 0; }
  .markdown-body a { color: #0969da; }
</style>
</head>
<body>
  <div class="header">
    <div class="crumb">
      <a href="/?issue=${number}">Issue #${number}</a>
      <span class="sep">/</span>
      <strong>${docLabel}</strong>
      <span class="sep">·</span>
      <span style="font-size:12px;color:#57606a">${escapeHtml(issueTitle)}</span>
      <span class="sep">·</span>
      <a href="/?issue=${number}" style="font-size:12px">${t('api.viewInDashboard')}</a>
    </div>
  </div>
  <div class="container">
    <div class="markdown-body">${htmlBody}</div>
  </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 审核历史与工作目录是否存在无关，仅以聚合状态为准。 */
function loadReviewHistory(number: number, tracker: IssueTracker) { return tracker.get(number)?.run?.reviewHistory ?? []; }

function getWorktreePlanDir(issueIid: number, _config: Config): string {
  return path.join(resolveDataDir(), 'issues', String(issueIid), 'artifacts');
}

async function readImmutablePlan(issueIid: number, filename: string, _config: Config, tracker: IssueTracker, _mainGit?: GitOperations): Promise<string | null> {
  const record = tracker.get(issueIid);
  if (filename === '01-plan.md' && record?.run?.planRevision) return renderPlan(tracker.store.readPlan(issueIid, record.run.planRevision, record.run.planDigest));
  return null;
}

async function readPlanFile(
  issueIid: number,
  filename: string,
  config: Config,
  tracker: IssueTracker,
  mainGit?: GitOperations,
): Promise<string | null> {
  if (filename === '01-plan.md') return readImmutablePlan(issueIid, filename, config, tracker, mainGit);
  if (filename === 'progress.json') { const record = tracker.get(issueIid); return record ? JSON.stringify({ displayId: issueIid, title: getTitle(record), branchName: record.branchName, currentPhase: record.currentPhase, phases: record.phaseProgress ?? {} }) : null; }
  const planDir = getWorktreePlanDir(issueIid, config);
  const filePath = path.join(planDir, filename);
  if (fs.existsSync(filePath)) {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }
  return readImmutablePlan(issueIid, filename, config, tracker, mainGit);
}

async function readProgress(
  issueIid: number,
  config: Config,
  tracker: IssueTracker,
  mainGit?: GitOperations,
): Promise<unknown | null> {
  // 刚重启的 Issue（Pending + 0 次尝试）不应返回旧进度数据
  const record = tracker.get(issueIid);
  if (record?.state === 'pending' && record.attempts === 0) {
    return null;
  }
  const content = await readPlanFile(issueIid, 'progress.json', config, tracker, mainGit);
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * 遍历所有 IssueState，调用 lm.derivePhaseStatuses 生成 { state → { phase → status } } 映射。
 * 为通用状态 PhaseRunning/PhaseDone，生成每个阶段的复合 key 条目。
 */
function buildPhaseStatusMap(
  def: PipelineDef,
  lm: ActionLifecycleManager,
): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (const state of Object.values(IssueState)) {
    result[state] = lm.derivePhaseStatuses(state);
  }
  // Generate composite key entries for generic PhaseRunning/PhaseDone per phase
  for (const phase of def.phases) {
    if (phase.startState === IssueState.PhaseRunning) {
      const compositeKey = `phase_running:${phase.name}`;
      result[compositeKey] = lm.derivePhaseStatuses(IssueState.PhaseRunning, phase.name);
    }
    if (phase.doneState === IssueState.PhaseDone) {
      const compositeKey = `phase_done:${phase.name}`;
      result[compositeKey] = lm.derivePhaseStatuses(IssueState.PhaseDone, phase.name);
    }
    // Generate composite key entries for generic PhaseWaiting/PhaseApproved per phase
    if (phase.startState === IssueState.PhaseWaiting) {
      const compositeKey = `phase_waiting:${phase.name}`;
      result[compositeKey] = lm.derivePhaseStatuses(IssueState.PhaseWaiting, phase.name);
    }
    if (phase.doneState === IssueState.PhaseApproved) {
      const compositeKey = `phase_approved:${phase.name}`;
      result[compositeKey] = lm.derivePhaseStatuses(IssueState.PhaseApproved, phase.name);
    }
    // Generate composite key entries for Failed per phase
    {
      const failedKey = `failed:${phase.name}`;
      result[failedKey] = lm.derivePhaseStatuses(IssueState.Failed, phase.name);
    }
    // Generate composite key entries for Paused per phase
    {
      const pausedKey = `paused:${phase.name}`;
      result[pausedKey] = lm.derivePhaseStatuses(IssueState.Paused, phase.name);
    }
  }
  return result;
}

/**
 * 合并所有模式的状态分类映射：{ state → ActionStatus }。
 */
function buildStateCategoryMap(
  lifecycleManagers: ActionLifecycleManager[],
): Record<string, string> {
  const result: Record<string, string> = {};
  const [first, ...rest] = lifecycleManagers;
  if (!first) return result;
  for (const state of Object.values(IssueState)) {
    const resolved = first.resolve(state);
    // 如果第一个 LM 映射不到具体阶段（fallback to idle），尝试其余 LM
    if (resolved.action === 'init' && resolved.status === 'idle' && state !== IssueState.Pending) {
      let found = false;
      for (const lm of rest) {
        const altResolved = lm.resolve(state);
        if (altResolved.action !== 'init' || altResolved.status !== 'idle') {
          result[state] = altResolved.status;
          found = true;
          break;
        }
      }
      if (!found) {
        result[state] = resolved.status;
      }
    } else {
      result[state] = resolved.status;
    }
  }
  return result;
}
