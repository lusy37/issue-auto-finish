import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManagedCodexRunner, configureAIConcurrency } from '../../src/ai-runner/ManagedCodexRunner.js';

let directory: string;
let file: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), '中文 worker 路径 '));
  file = path.join(directory, 'worker.mjs');
  fs.writeFileSync(file, `import fs from 'node:fs';
process.once('message', ({options}) => {
  fs.appendFileSync(options.workDir + '/started', options.prompt + '\\n');
  if (options.prompt === 'wait') { setInterval(() => {}, 1000); return; }
  process.send({type:'result',result:{success:true,output:'模拟 SDK 结果',exitCode:0}});
  setTimeout(() => process.disconnect(), 250);
});`);
  configureAIConcurrency(1);
});
afterEach(() => { configureAIConcurrency(4); fs.rmSync(directory, { recursive: true, force: true }); });
class TestWorker extends ManagedCodexRunner {
  protected workerEntrypoint() { return { file, source: false }; }
}
describe('受管理 worker 生命周期（模拟 IPC）', () => {
  it('收到结果后仍等待 worker 退出，之后才释放全局额度', async () => {
    const runner = new TestWorker();
    const first = runner.run({ workDir: directory, prompt: 'first', timeoutMs: 1000 });
    const second = runner.run({ workDir: directory, prompt: 'second', timeoutMs: 1000 });
    try {
      expect((await first).success).toBe(true);
      expect((await second).success).toBe(true);
      expect(fs.readFileSync(path.join(directory, 'started'), 'utf8').trim().split('\n')).toEqual(['first', 'second']);
    } finally { runner.killAll(); await Promise.allSettled([first, second]); }
  });
  it('取消等待的请求不启动 worker，中止当前请求后其他调用仍能执行', async () => {
    const runner = new TestWorker();
    const active = new AbortController(), queued = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const first = runner.run({ workDir: directory, prompt: 'wait', timeoutMs: 1000, signal: active.signal, onWorkerStarted: started });
    await ready;
    const second = runner.run({ workDir: directory, prompt: 'must-not-start', timeoutMs: 1000, signal: queued.signal });
    const rejected = expect(second).rejects.toThrow('取消');
    queued.abort();
    await rejected;
    active.abort();
    expect((await first).success).toBe(false);
    const third = await runner.run({ workDir: directory, prompt: 'third', timeoutMs: 1000 });
    expect(third.success).toBe(true);
    expect(fs.readFileSync(path.join(directory, 'started'), 'utf8')).not.toContain('must-not-start');
  });
});
