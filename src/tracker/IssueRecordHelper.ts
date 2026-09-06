import type { IssueRecord } from './IssueState.js';

/**
 * IssueRecord 身份字段辅助函数。
 *
 * 从 demandSpec 读取身份信息。
 */

/** 获取显示 IID（GitHub Issue IID） */
export function getIssueNumber(record: IssueRecord): number {
  return Number(record.demandSpec!.sourceRef.displayId);
}

/** 获取标题 */
export function getTitle(record: IssueRecord): string {
  return record.demandSpec!.title;
}
