import { writeJsonAtomicSync } from "../utils/atomicFile.js";
import type { DiaryStore } from "./DiaryStore.js";
import type { MemoryDistiller } from "./MemoryDistiller.js";
import type { AgentRuleDistiller } from "./AgentRuleDistiller.js";
import type { KnowledgeStore } from "../knowledge/KnowledgeStore.js";
import { eventBus } from "../events/EventBus.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveDataDir } from "../paths.js";
export interface DistillRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "completed" | "failed";
  error?: string;
  result?: unknown;
}
export interface DistillSchedulerDeps {
  diaryStore: DiaryStore;
  memoryDistiller: MemoryDistiller;
  agentRuleDistiller: AgentRuleDistiller;
  knowledgeStore: KnowledgeStore;
}
/** 保留调用入口，改为纯手动执行，无定时器和向量索引。 */
export class DistillScheduler {
  private running = false;
  private readonly file: string;
  private runs: DistillRun[];
  constructor(
    private deps: DistillSchedulerDeps,
    dataDir = path.join(resolveDataDir(), "distill"),
  ) {
    this.file = path.join(dataDir, "runs.json");
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (saved.format !== "iaf-mini/v1" || !Array.isArray(saved.runs))
        throw new Error("不支持的蒸馏记录格式");
      this.runs = saved.runs;
      for (const run of this.runs)
        if (run.status === "running") {
          run.status = "failed";
          run.error = "上次蒸馏被服务重启中断，请重新执行";
          run.finishedAt = new Date().toISOString();
        }
      this.save();
    } else this.runs = [];
  }
  private save() {
    writeJsonAtomicSync(this.file, { format: "iaf-mini/v1", runs: this.runs });
  }
  async runDistill(options?: { force?: boolean }) {
    if (this.running) throw new Error("已有蒸馏任务正在执行");
    this.running = true;
    const run: DistillRun = {
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      status: "running",
    };
    try {
      this.runs.unshift(run);
      this.save();
      eventBus.emitTyped("distill:started", {});
      const memory = await this.deps.memoryDistiller.distill(options);
      const rule = await this.deps.agentRuleDistiller.distill();
      run.status = "completed";
      run.result = { memory, rule };
      eventBus.emitTyped("distill:completed", { memory, rule });
      return { memory, rule };
    } catch (error) {
      run.status = "failed";
      run.error = (error as Error).message;
      throw error;
    } finally {
      this.running = false;
      run.finishedAt = new Date().toISOString();
      this.save();
    }
  }
  getStatus() {
    return {
      enabled: true,
      running: this.running,
      runs: this.runs,
      diaryCount: this.deps.diaryStore.count(),
      undistilledDiaryCount: this.deps.diaryStore.undistilledCount(),
      memoryCount: this.deps.knowledgeStore.list("memory").length,
      ruleCount: this.deps.knowledgeStore.list("agent-rule").length,
    };
  }
}
