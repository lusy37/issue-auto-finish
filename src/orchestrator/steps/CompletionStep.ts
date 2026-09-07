import { IssueState } from '../../tracker/IssueState.js';
import { GitOperations } from '../../git/GitOperations.js';
import type { IssueProcessingContext, OrchestratorDeps, PhaseLoopResult } from '../IssueProcessingContext.js';
import { ensurePrCreated } from './PhaseHelpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '../../paths.js';
import type { UatResult } from '../../e2e/PlaywrightRunner.js';

/** 所有执行阶段通过后，只在交付成功时写入任务成功终态。 */
export async function executeCompletion(ctx: IssueProcessingContext, deps: OrchestratorDeps, phaseResult: PhaseLoopResult): Promise<void> {
  const number=ctx.issue.number;
  const record=deps.tracker.get(number);
  if (!record || record.state===IssueState.Cancelled) throw new Error('任务已取消');
  if (record.phaseProgress?.uat?.status!=='completed') throw new Error('浏览器验收尚未通过，不能交付');
  const runId=record.uatRunId ?? JSON.parse(fs.readFileSync(path.join(ctx.wtCtx.workDir,'.claude-plan','issue-'+number,'uat-run.json'),'utf8')).runId;
  if (!runId || !/^[a-f0-9-]{36}$/.test(runId)) throw new Error('缺少本次浏览器验收记录');
  const result=JSON.parse(fs.readFileSync(path.join(resolveDataDir(),'uat',runId,'summary.json'),'utf8')) as UatResult;
  if (!result.passed || result.issueIid!==number || Date.parse(result.startedAt)<Date.parse(record.phaseProgress.uat.startedAt??record.createdAt)) throw new Error('浏览器验收记录无效');
  deps.tracker.updateState(number,IssueState.Delivering,{deliveryPending:true,uatRunId:runId});
  deps.emitProgress(number,'create_mr','验收通过，正在推送并创建合并请求');
  const git=new GitOperations(ctx.wtCtx.gitRootDir);
  if(await git.hasChanges()){await git.add(['.']);await git.commit(`chore(auto): deliver issue #${number}`);}
  await git.push(ctx.branchName);
  const pr=await ensurePrCreated(ctx,deps);
  if (!pr?.url) throw new Error('创建合并请求失败，请重试交付');
  if (!record.deliveryNoteWritten) {
    const marker=`<!-- iaf-delivery:${number}:${record.resetGeneration??0} -->`;
    const notes=await deps.github.listIssueNotes(ctx.issue.number);
    if (!notes.some(note=>note.body.includes(marker))) await deps.github.createIssueNote(ctx.issue.number,`任务已完成，浏览器验收通过。合并请求：${pr.url}\n${marker}`);
    deps.tracker.updateState(number,IssueState.Delivering,{deliveryNoteWritten:true});
  }
  await deps.github.updateIssueLabels(ctx.issue.number,[...ctx.issue.labels.filter(l=>!l.startsWith('auto-finish')),'auto-finish:done']);
  if (deps.tracker.get(number)?.state===IssueState.Cancelled) return;
  deps.tracker.updateState(number,IssueState.Completed,{deliveryPending:false,completedAt:new Date().toISOString(),worktreeCleanedAt:undefined,prUrl:pr.url});
  if (!phaseResult.serversStarted || !deps.config.preview.keepAfterComplete) deps.stopPreviewServers(number);
}
