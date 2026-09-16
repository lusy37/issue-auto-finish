import type {Config} from '../config.js';
import type {IssueTracker} from '../tracker/IssueTracker.js';
export function getE2eEnabled(cfg:Config):boolean{return cfg.e2e.enabled;}
/** 工作流定义就是本轮验收要求；仅尚未初始化的任务读取全局配置。 */
export function isE2eEnabledForIssue(iid:number,tracker:IssueTracker,cfg:Config):boolean {
  const record = tracker.get(iid);
  if (record?.run?.workflow.definition) return record.run.workflow.definition.phaseIds.includes('uat');
  // v3 过渡期兼容：v4 会拒绝没有 definition 的旧运行记录。
  if (record?.phaseProgress) return Object.hasOwn(record.phaseProgress, 'uat');
  return getE2eEnabled(cfg);
}
