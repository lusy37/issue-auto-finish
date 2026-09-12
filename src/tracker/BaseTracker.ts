import { writeJsonAtomicSync } from "../utils/atomicFile.js";
import fs from "node:fs";
import path from "node:path";
import { logger as rootLogger } from "../logger.js";

/**
 * BaseTracker — JSON 文件持久化的泛型 Tracker 基类。
 *
 * 集中公共的 load/save/get/getAll/delete 逻辑。
 * 子类通过构造函数参数注入 collectionKey 和 trackerName。
 */
export abstract class BaseTracker<TRecord> {
  protected readonly filePath: string;
  protected data: Record<string, Record<string, TRecord>>;

  /** JSON 根字段名（如 'issues' 或 'batches'）*/
  protected readonly collectionKey: string;
  protected readonly trackerName: string;

  constructor(
    dataDir: string,
    filename: string,
    collectionKey: string,
    trackerName: string,
  ) {
    this.collectionKey = collectionKey;
    this.trackerName = trackerName;
    this.filePath = path.join(dataDir, filename);
    this.data = this.load();
    this.cleanupStaleTempFiles();
  }
  protected load(): Record<string, Record<string, TRecord>> {
    if (!fs.existsSync(this.filePath)) return { [this.collectionKey]: {} };
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    if (
      parsed.format !== "iaf-mini/v1" ||
      !parsed[this.collectionKey] ||
      typeof parsed[this.collectionKey] !== "object" ||
      Array.isArray(parsed[this.collectionKey])
    )
      throw new Error("不支持此任务数据格式，请使用 .iaf-mini 新数据目录");
    return { [this.collectionKey]: parsed[this.collectionKey] };
  }

  protected save(): void {
    try {
      writeJsonAtomicSync(this.filePath, { format: "iaf-mini/v1", ...this.data });
    } catch (err) {
      const cause = err as NodeJS.ErrnoException;
      const wrapped = new Error(
        `Failed to persist ${this.trackerName} state to ${this.filePath}: ${cause.message}`,
      ) as NodeJS.ErrnoException;
      wrapped.code = cause.code;
      wrapped.errno = cause.errno;
      wrapped.syscall = cause.syscall;
      wrapped.path = cause.path ?? this.filePath;
      wrapped.cause = cause;
      rootLogger
        .child(this.trackerName)
        .error("Failed to persist tracker data", {
          filePath: this.filePath,
          code: cause.code,
          errno: cause.errno,
          syscall: cause.syscall,
          message: cause.message,
        });
      throw wrapped;
    }
  }

  /** 单实例启动时清理当前存储的库临时文件及迁移前的旧命名文件。 */
  private cleanupStaleTempFiles(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) return;
      const prefix = `.${this.trackerName}-`;
      const atomicPrefix = path.basename(this.filePath) + ".tmp-";
      let removed = 0;
      for (const name of fs.readdirSync(dir)) {
        const legacy = name.startsWith(prefix) && name.endsWith(".tmp");
        const atomic = name.startsWith(atomicPrefix) && /^\d{10}[a-f0-9]{6}$/.test(name.slice(atomicPrefix.length));
        if (legacy || atomic) {
          this.safeUnlinkTmp(path.join(dir, name));
          removed += 1;
        }
      }
      if (removed > 0) {
        rootLogger
          .child(this.trackerName)
          .info("Cleaned up stale tracker temp files", {
            dir,
            removed,
          });
      }
    } catch (err) {
      // 清理只是防御性操作，失败不影响主流程
      rootLogger
        .child(this.trackerName)
        .warn("Failed to cleanup stale temp files", {
          error: (err as Error).message,
        });
    }
  }

  private safeUnlinkTmp(tmpPath: string): void {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // 二次失败忽略 — 不要让清理本身再抛错掩盖原始 IO 错误
    }
  }

  /** 获取记录集合的引用 */
  protected get collection(): Record<string, TRecord> {
    return this.data[this.collectionKey] as Record<string, TRecord>;
  }

  protected getByKey(key: string): TRecord | undefined {
    return this.collection[key];
  }

  protected getAllRecords(): TRecord[] {
    return Object.values(this.collection);
  }

  protected setRecord(key: string, record: TRecord): void {
    this.collection[key] = record;
  }

  protected deleteByKey(key: string): boolean {
    if (!this.collection[key]) return false;
    delete this.collection[key];
    this.save();
    return true;
  }
}
