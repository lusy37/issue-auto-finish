import {it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parse} from 'dotenv';
import {envSchema,transformEnvToConfig} from '../../src/config-schema.js';
import {createSetupRouter} from '../../src/web/routes/setup.js';
import {createApp} from '../../src/web/createApp.js';
it('配置 API 保存后可重载，令牌不回显且空输入保留原值',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'iaf-settings-'));
  const file=path.join(dir,'.env');
  const previous=process.env.IAF_CONFIG_PATH;
  process.env.IAF_CONFIG_PATH=file;
  const cfg=transformEnvToConfig(envSchema.parse({GITHUB_TOKEN:'local-test-secret',GITHUB_REPOSITORY:'test/repo',PROJECT_WORK_DIR:dir}),dir);
  const server=createApp(dir,[createSetupRouter(cfg)]).listen(0,'127.0.0.1');
  try {
    if(!server.listening) await new Promise<void>(resolve=>server.once('listening',resolve));
    const address=server.address();
    if(!address||typeof address==='string')throw new Error('服务未启动');
    const url='http://127.0.0.1:'+address.port+'/api/settings';
    const update=await fetch(url,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({values:{GITHUB_TOKEN:'',GITHUB_REPOSITORY:'test/repo',PROJECT_WORK_DIR:dir,AI_PHASE_TIMEOUT_MS:'120000'}})});
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({success:true,restartRequired:true});
    const saved=parse(fs.readFileSync(file));
    expect(saved.GITHUB_TOKEN).toBe('local-test-secret');
    expect(saved.AI_PHASE_TIMEOUT_MS).toBe('120000');
    const data=await (await fetch(url)).json();
    expect(data.values.GITHUB_TOKEN).toBe('');
    expect(data.values.AI_PHASE_TIMEOUT_MS).toBe('120000');
    const invalid=await fetch(url,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({values:{GITHUB_REPOSITORY:'invalid'}})});
    expect(invalid.status).toBe(400);
    expect(parse(fs.readFileSync(file))).toEqual(saved);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(previous===undefined)delete process.env.IAF_CONFIG_PATH;else process.env.IAF_CONFIG_PATH=previous;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
