import { it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DiaryStore } from "../../../src/distill/DiaryStore.js";
import { KnowledgeStore } from "../../../src/knowledge/KnowledgeStore.js";
import { VersionStore } from "../../../src/distill/VersionStore.js";
import { MemoryDistiller } from "../../../src/distill/MemoryDistiller.js";
import { AgentRuleDistiller } from "../../../src/distill/AgentRuleDistiller.js";
import { DistillScheduler } from "../../../src/distill/DistillScheduler.js";
import { BasePhase } from "../../../src/phases/BasePhase.js";
import { PlanPersistence } from "../../../src/persistence/PlanPersistence.js";
import {
  createTestConfig,
  createMockGitOperations,
} from "../../helpers/mock-factories.js";
import type { AIRunner, RunOptions } from "../../../src/ai-runner/AIRunner.js";
import { IssueTracker } from "../../../src/tracker/IssueTracker.js";
import { PLAN_MODE_PIPELINE } from "../../../src/pipeline/PipelineMetadata.js";

it("非法蒸馏不消费日记；手动重试、规则启用、版本及执行记录可跨重启读取", async () => {
  const root = path.resolve(".iaf-mini/distill-tests");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "规则 "));
  vi.stubEnv("DATA_DIR", dir);
  const diaryStore = new DiaryStore(path.join(dir, "distill")),
    knowledgeStore = new KnowledgeStore(path.join(dir, "knowledge")),
    versionStore = new VersionStore(path.join(dir, "distill"));
  const now = new Date().toISOString();
  diaryStore.create({
    id: "d1",
    issueIid: 1,
    issueTitle: "测试",
    branchName: "feat/issue-1",
    pipelineMode: "plan-mode",
    outcome: "completed",
    timing: {
      totalDurationMs: 100,
      phaseTimings: [],
      startedAt: now,
      finishedAt: now,
    },
    humanInterventions: [],
    distilled: false,
    createdAt: now,
  });
  const outputs = [
    "不是有效 JSON",
    JSON.stringify({
      actions: [
        {
          type: "CREATE",
          theme: "failure-pattern",
          title: "真实验收",
          content: "根据真实报告判断验收",
          diaryIds: ["d1"],
        },
      ],
    }),
    JSON.stringify({
      actions: [
        {
          type: "CREATE",
          ruleName: "verify",
          title: "交付前验证",
          content: "必须检查本次验收报告",
          keywords: ["验收"],
          alwaysApply: true,
          sourceMemoryIds: [],
        },
      ],
    }),
  ];
  const calls: RunOptions[] = [];
  const runner: AIRunner = {
    killAll() {},
    killByWorkDir() {
      return 0;
    },
    async run(options) {
      calls.push(options);
      return {
        success: true,
        exitCode: 0,
        output: outputs.shift() || "已完成",
      };
    },
  };
  const deps = {
    diaryStore,
    knowledgeStore,
    memoryDistiller: new MemoryDistiller({
      aiRunner: runner,
      diaryStore,
      knowledgeStore,
      versionStore,
      workDir: dir,
      aiPolicy: { timeoutMs: 1000, idleTimeoutMs: 4567, timeoutGraceMs: 123, timeoutExtensionMs: 789, timeoutMaxExtensions: 2, model: 'test-model' },
      minDiariesForDistill: 1,
    }),
    agentRuleDistiller: new AgentRuleDistiller({
      aiRunner: runner,
      knowledgeStore,
      versionStore,
      workDir: dir,
      aiPolicy: { timeoutMs: 1000, idleTimeoutMs: 4567, timeoutGraceMs: 123, timeoutExtensionMs: 789, timeoutMaxExtensions: 2, model: 'test-model' },
      confidenceThreshold: 0.2,
    }),
  };
  try {
    const scheduler = new DistillScheduler(deps, path.join(dir, "distill"));
    await expect(scheduler.runDistill({ force: true })).rejects.toThrow(
      "无法解析蒸馏结果",
    );
    expect(diaryStore.undistilledCount()).toBe(1);
    expect(scheduler.getStatus().runs[0].status).toBe("failed");
    await scheduler.runDistill({ force: true });
    expect(diaryStore.undistilledCount()).toBe(0);
    const meta = knowledgeStore.list("agent-rule")[0],
      rule = JSON.parse(knowledgeStore.get(meta.id)!.content);
    expect(versionStore.getByEntryId(rule.id)).toHaveLength(1);
    expect(
      fs.readFileSync(
        path.join(dir, "rules", `distilled-${rule.id}.md`),
        "utf8",
      ),
    ).toContain("# 交付前验证");
    expect(meta.tags).not.toContain("enabled");
    class ContextPhase extends BasePhase {
      readonly phaseName = "build";
      protected buildPrompt() {
        return "实现任务";
      }
    }
    const tracker = new IssueTracker(dir, new Map([["plan-mode", PLAN_MODE_PIPELINE]]));
    tracker.create({
      lifecycle: { kind: "pending" },
      pipelineMode: "plan-mode",
      demandSpec: {
        demandId: "gh-1",
        sourceRef: { source: "github-issue", externalId: "1", displayId: "1" },
        title: "任务",
        description: "验收",
        createdAt: now,
      },
      branchName: "feat/issue-1",
    });
    tracker.initPhaseProgress(1, PLAN_MODE_PIPELINE);
    const plan = new PlanPersistence(dir, 1, dir, tracker),
      phase = new ContextPhase(
        runner,
        createMockGitOperations() as never,
        plan,
        createTestConfig(),
        tracker,
      );
    const ctx = {
      demand: {
        demandId: "gh-1",
        sourceRef: {
          source: "github-issue" as const,
          externalId: "1",
          displayId: "1",
        },
        title: "任务",
        description: "验收",
        createdAt: now,
      },
      branchName: "feat/issue-1",
    };
    await phase.run(ctx);
    expect(calls.at(-1)!.prompt).not.toContain(rule.content);
    knowledgeStore.update(meta.id, { tags: [...meta.tags, "enabled"] });
    await phase.run(ctx);
    expect(calls.at(-1)!.prompt).toContain(rule.content);
    // 恢复会话同样加载当前启用规则，避免恢复旧上下文后遗漏规则。
    tracker.updatePhaseProgress(1, "build", { status: "failed", sessionId: "session-1" });
    await phase.run(ctx);
    expect(calls.at(-1)!.prompt).toContain(rule.content);
    expect(
      new DistillScheduler(deps, path.join(dir, "distill"))
        .getStatus()
        .runs.map((r) => r.status),
    ).toEqual(["completed", "failed"]);
  } finally {
    vi.unstubAllEnvs();
  }
});
