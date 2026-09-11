import {it,expect,vi} from 'vitest';
import express from 'express';
import {createApiRouter} from '../../src/web/routes/api.js';
import {createMockIssueTracker,createTestConfig} from '../helpers/mock-factories.js';

async function withApi(run: (base:string, tracker:ReturnType<typeof createMockIssueTracker>, github:any)=>Promise<void>) {
  const tracker=createMockIssueTracker();
  tracker.get.mockReturnValue(undefined);
  const github={getIssueDetail:vi.fn(),addLabel:vi.fn().mockResolvedValue(undefined)};
  const app=express();
  app.use(express.json());
  app.use(createApiRouter({tracker,config:createTestConfig(),github,agentLogStore:{},orchestrator:{}} as never));
  const server=app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();
  if(!address||typeof address==='string')throw new Error('测试服务未启动');
  try{await run('http://127.0.0.1:'+address.port,tracker,github);}
  finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
const issue={id:103,number:3,title:'并发任务',description:'测试',state:'open',labels:[],created_at:'2026-09-12T00:00:00Z',updated_at:'2026-09-12T00:00:00Z',author:{username:'test',name:'test'}};
const start=(base:string)=>fetch(base+'/api/issues/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({issueIid:3})});

it('同一编号并发启动仅创建一次任务和平台标签',async()=>withApi(async(base,tracker,github)=>{
  let release!:(value:typeof issue)=>void;
  let entered!:()=>void;
  const waiting=new Promise<void>(resolve=>{entered=resolve;});
  github.getIssueDetail.mockImplementation(()=>{entered();return new Promise(resolve=>{release=resolve;});});
  const first=start(base);
  await waiting;
  try{expect((await start(base)).status).toBe(409);}
  finally{release(issue);}
  expect((await first).status).toBe(200);
  expect(github.getIssueDetail).toHaveBeenCalledTimes(1);
  expect(github.addLabel).toHaveBeenCalledTimes(1);
  expect(tracker.create).toHaveBeenCalledTimes(1);
}));

it('平台查询失败后释放编号，允许再次启动',async()=>withApi(async(base,tracker,github)=>{
  github.getIssueDetail.mockRejectedValueOnce(new Error('暂时不可用')).mockResolvedValueOnce(issue);
  expect((await start(base)).status).toBe(400);
  expect((await start(base)).status).toBe(200);
  expect(tracker.create).toHaveBeenCalledTimes(1);
}));
