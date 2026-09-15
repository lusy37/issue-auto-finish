import type {Config} from '../config.js';
import type {IssueTracker} from '../tracker/IssueTracker.js';
export function getE2eEnabled(cfg:Config):boolean{return cfg.e2e.enabled;}
/** 阶段列表就是本轮验收要求；仅尚未初始化的任务读取全局配置。 */
export function isE2eEnabledForIssue(iid:number,tracker:IssueTracker,cfg:Config):boolean {
  const record = tracker.get(iid);
  return record?.phaseProgress ? Object.hasOwn(record.phaseProgress, 'uat') : getE2eEnabled(cfg);
}
