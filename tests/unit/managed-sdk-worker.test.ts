import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
class SourceWorker extends ManagedCodexRunner {
  protected workerEntrypoint() { return { file: path.join(directory, 'worker.ts'), source: true }; }
  inspectArguments() {
    const entrypoint = this.workerEntrypoint();
    return { entrypoint, args: this.workerArguments(entrypoint.file, entrypoint.source) };
  }
}
class EnvironmentWorker extends ManagedCodexRunner {
  inspectEnvironment() { return this.codexEnvironment(); }
}
describe('受管理 worker 生命周期（模拟 IPC）', () => {
  it('未设置 CODEX_HOME 时不注入独立配置目录', () => {
    const previous = {
      CODEX_HOME: process.env.CODEX_HOME,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
    };
    process.env.USERPROFILE = directory;
    process.env.HOME = directory;
    fs.mkdirSync(path.join(directory, '.codex'));
    delete process.env.CODEX_HOME;
    try {
      expect(new EnvironmentWorker().inspectEnvironment().CODEX_HOME).toBeUndefined();
    } finally {
      if (previous.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous.CODEX_HOME;
      if (previous.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = previous.HOME;
      if (previous.USERPROFILE === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previous.USERPROFILE;
    }
  });

  it('显式 CODEX_HOME 时保持调用方配置', () => {
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(directory, 'codex-home');
    try {
      expect(new EnvironmentWorker().inspectEnvironment().CODEX_HOME).toBe(process.env.CODEX_HOME);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });

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
  it('源码模式使用项目根目录的 tsx loader 和 TS worker', () => {
    const { entrypoint, args } = new SourceWorker().inspectArguments();
    expect(entrypoint.file).toBe(path.join(directory, 'worker.ts'));
    expect(args).toEqual([
      '--import',
      pathToFileURL(path.join(process.cwd(), 'node_modules/tsx/dist/loader.mjs')).href,
      path.join(directory, 'worker.ts'),
    ]);
  });
});
