import type { Config } from '../config.js';
import type { IssueTracker } from '../tracker/IssueTracker.js';
export function getE2eEnabled(cfg: Config): boolean {
  return cfg.e2e.enabled;
}
/** 工作流定义就是本轮验收要求；仅尚未初始化的任务读取全局配置。 */
export function isE2eEnabledForIssue(iid: number, tracker: IssueTracker, cfg: Config): boolean {
  const record = tracker.get(iid);
  if (record?.run?.workflow.definition)
    return record.run.workflow.definition.phaseIds.includes('uat');
  // 尚未初始化 workflow definition 的新任务读取当前配置；初始化后只读不可变定义。
  return getE2eEnabled(cfg);
}
