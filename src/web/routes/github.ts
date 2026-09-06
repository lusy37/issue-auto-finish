import {Router} from 'express';
import {GitHubClient} from '../../clients/GitHubClient.js';
/** 浏览接口复用正式平台客户端，平台调用失败交由统一错误处理。 */
export function createGitHubRouter(client: GitHubClient) {
  const router=Router();
  router.get('/api/github/issues', async (req,res,next)=> {
    try {
      const page=Math.max(1,Number(req.query.page)||1);
      const perPage=Math.min(100,Math.max(1,Number(req.query.perPage)||20));
      const result=await client.listIssuesAdvanced({page,perPage,search:String(req.query.search||'')});
      res.json({...result,page,perPage});
    } catch(error) {next(error);}
  });
  router.post('/api/settings/check-github',async (_req,res,next)=> {
    try {const repo=await client.checkConnection();res.json({ok:true,message:'已连接 '+repo.fullName});}
    catch(error) {next(error);}
  });
  return router;
}
