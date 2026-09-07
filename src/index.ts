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
import { PipelineOrchestrator } from "./orchestrator/PipelineOrchestrator.js";
import {
  buildPlanModePipeline,
  registerPipeline,
  createLifecycleManager,
} from "./pipeline/PipelineDefinition.js";
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
import { PreviewReaper } from "./deploy/PreviewReaper.js";
import { WorktreeReaper } from "./workspace/WorktreeReaper.js";
import { acquireInstanceLock } from "./utils/InstanceLock.js";

/** 单进程装配：一套任务状态、平台客户端和执行器。 */
export async function main(): Promise<void> {
  const config = loadConfig();
  setLocale(config.locale);
  const dataDir = ensureDir(resolveDataDir());
  const releaseLock = acquireInstanceLock(dataDir);
  try {
    loadKnowledge(config.knowledge.path);
    const pipeline = buildPlanModePipeline({ e2eEnabled: config.e2e.enabled });
    registerPipeline(pipeline);
    const tracker = new IssueTracker(
      dataDir,
      new Map([[pipeline.mode, createLifecycleManager(pipeline)]]),
    );
    const github = new GitHubClient(config.github);
    const aiRunner = createAIRunner(config.ai);
    const mainGit = new GitOperations(config.project.gitRootDir);
    const supplementStore = new SupplementStore(dataDir);
    const orchestrator = new PipelineOrchestrator(
      config,
      github,
      mainGit,
      aiRunner,
      tracker,
      supplementStore,
      new AsyncMutex(),
    );
    const poller = new IssuePoller(config, github, tracker, orchestrator);
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
        ),
    });
    const memoryDistiller = new MemoryDistiller({
      aiRunner,
      diaryStore,
      knowledgeStore,
      versionStore,
      workDir: config.project.workDir,
      timeoutMs: config.ai.phaseTimeoutMs,
      minDiariesForDistill: config.distill.minDiariesForDistill,
    });
    const agentRuleDistiller = new AgentRuleDistiller({
      aiRunner,
      knowledgeStore,
      versionStore,
      workDir: config.project.workDir,
      timeoutMs: config.ai.phaseTimeoutMs,
      confidenceThreshold: config.distill.memoryConfidenceThreshold,
    });
    const distillScheduler = new DistillScheduler({
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
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      setShuttingDown();
      poller.stop();
      aiRunner.killAll();
      orchestrator.cancelUat();
      orchestrator.getDevServerManager().stopAll();
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
