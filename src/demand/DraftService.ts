import type {DraftBatch} from '../shared/workbench.js';
export type {TaskDraft,DraftBatch} from '../shared/workbench.js';
import { replaceFileSync } from "../utils/atomicFile.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AIRunner } from "../ai-runner/AIRunner.js";
import type { GitHubClient } from "../clients/GitHubClient.js";
import { ensureDir } from "../paths.js";
import { AsyncMutex } from "../utils/AsyncMutex.js";
const taskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(10000),
  acceptanceCriteria: z.string().trim().min(1).max(5000),
});


/** 草稿只负责确认和创建 Issue，不包含第二套任务执行引擎。 */
export class DraftService {
  private mutex = new AsyncMutex();
  constructor(
    private directory: string,
    private runner: AIRunner,
    private client: Pick<GitHubClient, "createIssue">,
    private workDir: string,
    private issueBaseUrl: string,
  ) {
    ensureDir(directory);
  }
  private file(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("草稿编号无效");
    return path.join(this.directory, id + ".json");
  }
  private save(batch: DraftBatch) {
    const file = this.file(batch.id);
    fs.writeFileSync(file + ".tmp", JSON.stringify(batch, null, 2));
    replaceFileSync(file + ".tmp", file);
  }
  list(): DraftBatch[] {
    return fs
      .readdirSync(this.directory)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.get(f.slice(0, -5)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  get(id: string): DraftBatch {
    const batch = JSON.parse(
      fs.readFileSync(this.file(id), "utf8"),
    ) as DraftBatch;
    for (const task of batch.tasks)
      if (task.status === "creating") {
        task.status = "unknown";
        task.error = "上次创建结果未知，请核对平台后关联 Issue";
      }
    return batch;
  }
  async generate(input: string): Promise<DraftBatch> {
    if (!input.trim() || input.length > 20000)
      throw new Error("需求长度必须为 1～20000 字符");
    const result = await this.runner.run({
      workDir: this.workDir,
      mode: "plan",
      timeoutMs: 120000,
      prompt: `将以下需求拆成 1～10 个可独立审核的 Issue 草稿。仅返回 JSON：{"tasks":[{"title":"标题","description":"说明","acceptanceCriteria":"验收标准"}]}。不执行代码修改。\n${input}`,
    });
    if (!result.success) throw new Error(result.errorMessage || "需求拆分失败");
    const text =
      result.output.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? result.output;
    const data = z
      .object({ tasks: z.array(taskSchema).min(1).max(10) })
      .parse(JSON.parse(text));
    const batch: DraftBatch = {
      id: randomUUID(),
      input,
      createdAt: new Date().toISOString(),
      tasks: data.tasks.map((task) => ({
        ...task,
        id: randomUUID(),
        status: "draft",
      })),
    };
    this.save(batch);
    return batch;
  }
  async edit(id: string, taskId: string, input: unknown) {
    return this.mutex.runExclusive(async () => {
      const batch = this.get(id);
      const task = batch.tasks.find((t) => t.id === taskId);
      if (!task || !["draft", "failed"].includes(task.status))
        throw new Error("当前草稿不可修改");
      Object.assign(task, taskSchema.parse(input));
      this.save(batch);
      return batch;
    });
  }
  async confirm(id: string, ids: string[]): Promise<DraftBatch> {
    return this.mutex.runExclusive(async () => {
      const batch = this.get(id);
      if (
        !ids.length ||
        ids.some((id) => !batch.tasks.some((t) => t.id === id))
      )
        throw new Error("请选择有效草稿");
      for (const task of batch.tasks.filter((t) => ids.includes(t.id))) {
        if (task.status === "created") continue;
        if (task.status === "unknown")
          throw new Error("存在结果未知的草稿，请先核对平台并关联");
        task.status = "creating";
        task.error = undefined;
        this.save(batch);
        try {
          const issue = await this.client.createIssue(
            task.title,
            `${task.description}\n\n## 验收标准\n${task.acceptanceCriteria}\n\n<!-- draft:${batch.id}:${task.id} -->`,
          );
          task.status = "created";
          task.issueIid = issue.number;
          task.issueUrl = `${this.issueBaseUrl}/issues/${issue.number}`;
        } catch (err) {
          task.status = "unknown";
          task.error = (err as Error).message;
        }
        this.save(batch);
      }
      return batch;
    });
  }
  async reconcile(id: string, taskId: string, issueIid: number | null) {
    return this.mutex.runExclusive(async () => {
      const batch = this.get(id);
      const task = batch.tasks.find((t) => t.id === taskId);
      if (!task || task.status !== "unknown") throw new Error("该草稿无需核对");
      if (issueIid !== null && (!Number.isInteger(issueIid) || issueIid <= 0))
        throw new Error("Issue 编号无效");
      task.status = issueIid === null ? "draft" : "created";
      task.issueIid = issueIid ?? undefined;
      task.issueUrl =
        issueIid === null
          ? undefined
          : `${this.issueBaseUrl}/issues/${issueIid}`;
      task.error = undefined;
      this.save(batch);
      return batch;
    });
  }
}
