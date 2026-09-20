import { configuredCallPolicy } from './ai-runner/CallPolicy.js';
import { validateDraftStorage } from "./demand/DraftService.js";
import path from "node:path";
import { loadConfig } from "./config.js";
import { setLocale } from "./i18n/index.js";
import { loadKnowledge } from "./knowledge/index.js";
import { logger } from "./logger.js";
import { GitHubClient } from "./clients/GitHubClient.js";
import { GitOperations } from "./git/GitOperations.js";
import { createAIRunner } from "./ai-runner/index.js";
import { IssueTracker } from "./tracker/IssueTracker.js";
import { SupplementStore } from "./supplement/SupplementStore.js";
import { IssueService } from "./orchestrator/IssueService.js";
import {
  buildPlanModePipeline,
  registerPipeline,
} from "./pipeline/PipelineMetadata.js";
import { IssuePoller } from "./poller/IssuePoller.js";
import { WebServer } from "./web/WebServer.js";
import { AgentLogStore } from "./web/AgentLogStore.js";
import { AsyncMutex } from "./utils/AsyncMutex.js";
import { setShuttingDown } from "./shutdown/ShutdownSignal.js";
import { resolveDataDir, ensureDir } from "./paths.js";
import { PlanPersistence } from "./persistence/PlanPersistence.js";
import { KnowledgeStore } from "./knowledge/KnowledgeStore.js";
import { DiaryStore } from "./distill/DiaryStore.js";
import { DiaryCollector } from "./distill/DiaryCollector.js";
import { MemoryDistiller } from "./distill/MemoryDistiller.js";
import { AgentRuleDistiller } from "./distill/AgentRuleDistiller.js";
import { VersionStore } from "./distill/VersionStore.js";
import { DistillScheduler } from "./distill/DistillScheduler.js";
import { PreviewReaper } from "./preview/PreviewReaper.js";
import { WorktreeReaper } from "./workspace/WorktreeReaper.js";
import { acquireInstanceLock } from "./utils/InstanceLock.js";

/** 单进程装配：一套任务状态、平台客户端和执行器。 */
export async function main(): Promise<void> {
  // 启动基础环境：配置、语言、数据目录和单实例锁。
  const config = loadConfig();
  setLocale(config.locale);
  const dataDir = ensureDir(resolveDataDir());
  const releaseLock = acquireInstanceLock(dataDir);
  try {
    // 注册 Issue 阶段流水线，并创建状态跟踪器。
    loadKnowledge(config.knowledge.path);
    const pipeline = buildPlanModePipeline({ e2eEnabled: config.e2e.enabled });
    registerPipeline(pipeline);
    const tracker = new IssueTracker(
      dataDir,
      new Map([[pipeline.mode, pipeline]]),
    );
    validateDraftStorage(path.join(dataDir, "drafts"));

    // 创建外部平台、Git、AI 和 Issue 编排服务。
    const github = new GitHubClient(config.github);
    const aiRunner = createAIRunner(config.ai);
    const mainGit = new GitOperations(config.project.gitRootDir);
    const supplementStore = new SupplementStore(dataDir);
    const orchestrator = new IssueService(
      config,
      github,
      mainGit,
      aiRunner,
      tracker,
      supplementStore,
      new AsyncMutex(),
    );
    const poller = new IssuePoller(config, github, tracker, orchestrator);

    // 创建日志、知识蒸馏和后台清理服务。
    const agentLogStore = new AgentLogStore(dataDir);
    agentLogStore.startListening();
    const knowledgeStore = new KnowledgeStore(
      ensureDir(path.join(dataDir, "knowledge")),
    );
    const distillDir = ensureDir(path.join(dataDir, "distill"));
    const diaryStore = new DiaryStore(distillDir);
    const versionStore = new VersionStore(distillDir);
    const diaryCollector = new DiaryCollector({
      tracker,
      diaryStore,
      createPlanPersistence: (number) =>
        new PlanPersistence(
          path.join(
            config.project.worktreeBaseDir,
            `issue-${number}`,
            config.project.projectSubDir,
          ),
          number,
          dataDir,
          tracker,
        ),
    });
    const memoryDistiller = new MemoryDistiller({
      aiRunner,
      diaryStore,
      knowledgeStore,
      versionStore,
      workDir: config.project.workDir,
      aiPolicy: configuredCallPolicy(config.ai),
      minDiariesForDistill: config.distill.minDiariesForDistill,
    });
    const agentRuleDistiller = new AgentRuleDistiller({
      aiRunner,
      knowledgeStore,
      versionStore,
      workDir: config.project.workDir,
      aiPolicy: configuredCallPolicy(config.ai),
      confidenceThreshold: config.distill.memoryConfidenceThreshold,
    });
    const distillScheduler = new DistillScheduler({
      enabled: config.distill.enabled,
      diaryStore,
      memoryDistiller,
      agentRuleDistiller,
      knowledgeStore,
    });
    diaryCollector.start();
    const previewReaper = new PreviewReaper({
      tracker,
      orchestrator,
      intervalMs: config.preview.reapIntervalMs,
      ttlMs: config.preview.ttlMs,
    });
    const worktreeReaper = new WorktreeReaper({
      orchestrator,
      intervalMs: config.worktree.cleanupIntervalMs,
      retentionMs: config.worktree.retentionMs,
      enabled: config.worktree.cleanupEnabled,
    });
    const web = new WebServer({
      config,
      tracker,
      github,
      orchestrator,
      poller,
      mainGit,
      supplementStore,
      agentLogStore,
      aiRunner,
      knowledgeStore,
      diaryStore,
      diaryCollector,
      distillScheduler,
      previewReaper,
      worktreeReaper,
    });

    // 注册进程信号处理，并按依赖关系协调关闭所有组件。
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      setShuttingDown();
      poller.stop();
      aiRunner.killAll();
      await orchestrator.stopExecutions();
      await aiRunner.waitForIdle?.();
      orchestrator.cancelUat();
      await orchestrator.getDevServerManager().stopAllAndWait();
      previewReaper.stop();
      worktreeReaper.stop();
      diaryCollector.stop();
      const deadline = Date.now() + 5000;
      while (poller.getActiveCount() && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 100));
      web.stop();
      releaseLock();
    };
    process.once("SIGINT", () => {
      void shutdown().then(() => process.exit(0));
    });
    process.once("SIGTERM", () => {
      void shutdown().then(() => process.exit(0));
    });

    // 恢复中断任务后启动 Web、Issue 轮询和后台清理器。
    try {
      tracker.recoverInterruptedIssues();
      await web.start();
      poller.start();
      previewReaper.start();
      worktreeReaper.start();
      logger.info("工作台已启动", {
        url: `http://${config.web.host}:${config.web.port}`,
      });
    } catch (err) {
      await shutdown();
      throw err;
    }
  } catch (err) {
    releaseLock();
    throw err;
  }
}
