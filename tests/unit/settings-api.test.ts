import {it,expect,vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parse} from 'dotenv';
import {envSchema,extractEnvSubset,transformEnvToConfig} from '../../src/config-schema.js';
import * as atomic from '../../src/utils/atomicFile.js';
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

it('流程配置：默认值、持久化、重启生效与非法输入保护', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iaf-flow-settings-'));
  const file = path.join(dir, '.env');
  vi.stubEnv('IAF_CONFIG_PATH', file);
  const base = { GITHUB_TOKEN: 'test', GITHUB_REPOSITORY: 'test/repo', PROJECT_WORK_DIR: dir };
  fs.writeFileSync(file, Object.entries(base).map(([key, value]) => `${key}='${value}'`).join('\n'));
  const cfg = transformEnvToConfig(envSchema.parse(base), dir);
  const server = createApp(dir, [createSetupRouter(cfg)]).listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('服务未启动');
    const url = `http://127.0.0.1:${address.port}/api/settings`;
    const put = (values: Record<string, string>) => fetch(url, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }),
    });
    const defaults = (await (await fetch(url)).json()).values;
    const switches = ['E2E_UI_ENABLED', 'REVIEW_ENABLED', 'KNOWLEDGE_ENABLED', 'DISTILL_ENABLED', 'VERIFY_FIX_LOOP_ENABLED'];
    for (const key of switches) expect(defaults[key]).toBe('true');
    expect(defaults.VERIFY_FIX_MAX_ITERATIONS).toBe('3');
    expect(defaults).not.toHaveProperty('WEB_ENABLED');

    const values = { ...Object.fromEntries(switches.map(key => [key, 'false'])), VERIFY_FIX_MAX_ITERATIONS: '1' };
    expect(await (await put(values)).json()).toMatchObject({ success: true, restartRequired: true });
    expect((await (await fetch(url)).json()).values).toMatchObject(values);
    expect(cfg.review.enabled).toBe(true);
    expect(cfg.verifyFixLoop.maxIterations).toBe(3);
    const restored = transformEnvToConfig(envSchema.parse(extractEnvSubset(parse(fs.readFileSync(file)))), dir);
    expect(restored).toMatchObject({
      e2e: { enabled: false }, review: { enabled: false }, knowledge: { enabled: false }, distill: { enabled: false },
      verifyFixLoop: { enabled: false, maxIterations: 1 },
    });

    const before = fs.readFileSync(file, 'utf8');
    for (const value of ['0', '11', '1.5', 'abc']) {
      expect((await put({ VERIFY_FIX_MAX_ITERATIONS: value })).status).toBe(400);
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    }
    for (const key of switches) {
      expect((await put({ [key]: 'invalid' })).status).toBe(400);
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    }
    expect((await put({ WEB_ENABLED: 'false' })).status).toBe(400);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    vi.spyOn(atomic, 'writeTextAtomicSync').mockImplementationOnce(() => { throw new Error('模拟磁盘已满'); });
    const failed = await put({ REVIEW_ENABLED: 'true' });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: '模拟磁盘已满' });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.appendFileSync(file, "\nWEB_ENABLED='true'\n");
    expect((await put({ VERIFY_FIX_MAX_ITERATIONS: '10' })).status).toBe(200);
    expect(warning).toHaveBeenCalled();
    expect(parse(fs.readFileSync(file))).not.toHaveProperty('WEB_ENABLED');
    expect(() => extractEnvSubset({ ...base, WEB_ENABLED: 'false' })).toThrow('Web 工作台固定开启');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
