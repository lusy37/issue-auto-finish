/**
 * DiaryStore — 日记持久化存储。
 *
 * 继承 BaseTracker<DiaryEntry>，JSON 文件持久化到传入数据目录下的 diaries.json。
 */
import { BaseTracker } from '../tracker/BaseTracker.js';
import type { DiaryEntry } from './types.js';

export class DiaryStore extends BaseTracker<DiaryEntry> {
  constructor(dataDir: string) {
    super(dataDir, 'diaries.json', 'diaries', 'diary-store');
  }

  /** 创建新日记条目 */
  create(entry: DiaryEntry): void {
    this.setRecord(entry.id, entry);
    this.save();
  }

  /** 按 ID 获取日记 */
  get(id: string): DiaryEntry | undefined {
    return this.getByKey(id);
  }

  /** 获取所有日记 */
  getAll(): DiaryEntry[] {
    return this.getAllRecords();
  }

  /** 获取未蒸馏的日记列表 */
  getUndistilled(): DiaryEntry[] {
    return this.getAllRecords().filter(d => !d.distilled);
  }

  /** 按 Issue IID 获取日记 */
  getByIssueIid(issueIid: number): DiaryEntry[] {
    return this.getAllRecords().filter(d => d.issueIid === issueIid);
  }

  /** 标记日记已蒸馏 */
  markDistilled(ids: string[]): void {
    let changed = false;
    for (const id of ids) {
      const entry = this.getByKey(id);
      if (entry && !entry.distilled) {
        entry.distilled = true;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** 删除日记 */
  delete(id: string): boolean {
    return this.deleteByKey(id);
  }

  /** 获取日记总数 */
  count(): number {
    return this.getAllRecords().length;
  }

  /** 获取未蒸馏日记数 */
  undistilledCount(): number {
    return this.getUndistilled().length;
  }
}
