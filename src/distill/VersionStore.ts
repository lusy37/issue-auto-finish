import { replaceFileSync } from "../utils/atomicFile.js";
/**
 * VersionStore — 知识条目版本历史管理。
 *
 * 为 memory 和 agent-rule 条目保留版本历史，支持知识退役追溯。
 * 简单 JSON 文件持久化到 data/distill/versions.json。
 */
import fs from "node:fs";
import path from "node:path";
import { logger as rootLogger } from "../logger.js";
import type { VersionRecord } from "./types.js";

const logger = rootLogger.child("VersionStore");

interface VersionData {
  records: VersionRecord[];
}

export class VersionStore {
  private filePath: string;
  private data: VersionData;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "versions.json");
    this.data = this.load();
  }

  /** 追加版本记录 */
  append(record: VersionRecord): void {
    this.data.records.push(record);
    this.save();
  }

  /** 按条目 ID 获取版本历史 */
  getByEntryId(entryId: string): VersionRecord[] {
    return this.data.records
      .filter((r) => r.entryId === entryId)
      .sort((a, b) => a.version - b.version);
  }

  /** 获取所有版本记录 */
  getAll(): VersionRecord[] {
    return [...this.data.records];
  }

  /** 获取记录总数 */
  count(): number {
    return this.data.records.length;
  }

  private load(): VersionData {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        return JSON.parse(raw) as VersionData;
      }
    } catch (err) {
      logger.warn("Failed to load version store", {
        error: (err as Error).message,
      });
    }
    return { records: [] };
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = path.join(
      dir,
      `.versions-${process.pid}-${Date.now()}.tmp`,
    );
    fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), "utf-8");
    replaceFileSync(tmpPath, this.filePath);
  }
}
