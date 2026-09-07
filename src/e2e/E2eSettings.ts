import type {Config} from '../config.js';
import type {IssueTracker} from '../tracker/IssueTracker.js';
export function getE2eEnabled(cfg:Config):boolean{return cfg.e2e.enabled;}
export function isE2eEnabledForIssue(_iid:number,_tracker:IssueTracker,cfg:Config):boolean{return getE2eEnabled(cfg);}
