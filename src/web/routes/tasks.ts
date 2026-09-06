import {Router} from 'express';
import type {Config} from '../../config.js';
import type {GitHubClient} from '../../clients/GitHubClient.js';
import type {IssueTracker} from '../../tracker/IssueTracker.js';
import {IssueState} from '../../tracker/IssueState.js';
import {githubIssueToDemandSpec} from '../../demand/adapters/GitHubAdapter.js';
/** 队列入口先完成校验与防重，执行由后续编排器驱动。 */
export function createTaskRouter(tracker:IssueTracker,github:GitHubClient,config:Config){
  const router=Router();
  const creating=new Set<number>();
  router.get('/api/tasks',(_req,res)=>res.json(tracker.toExecutableTasks()));
  router.get('/api/issues',(_req,res)=>res.json(tracker.getAll()));
  router.get('/api/issues/:number',(req,res)=>{
    const record=tracker.get(Number(req.params.number));
    if(!record){res.status(404).json({error:'任务不存在'});return;}
    res.json(record);
  });
  router.post('/api/issues/start',async(req,res,next)=>{
    const number=req.body.issueIid;
    if(!Number.isSafeInteger(number)||number<1){res.status(400).json({error:'需要正整数 Issue 编号 issueIid'});return;}
    if(creating.has(number)||tracker.get(number)){res.status(409).json({error:'任务已在队列中'});return;}
    creating.add(number);
    try{
      const issue=await github.getIssueDetail(number);
      const record=tracker.create({state:IssueState.Pending,branchName:config.project.branchPrefix+'-'+number,demandSpec:githubIssueToDemandSpec(issue)});
      res.json({success:true,record});
    }catch(error){next(error);}finally{creating.delete(number);}
  });
  return router;
}
