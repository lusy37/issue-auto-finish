import { it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DevServerManager } from '../../src/preview/DevServerManager.js';
import { PortAllocator } from '../../src/preview/PortAllocator.js';

it.each(['exit', 'timeout', 'cancel', 'immediate-stop'] as const)('预览启动 %s 后不遗留进程', async mode => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '预览启动-'));
  vi.stubEnv('DATA_DIR', path.join(directory, 'runtime'));
  const ports = await new PortAllocator({ backendPortBase: 21000, frontendPortBase: 22000, maxPorts: 100 }).allocate(1);
  const manager = new DevServerManager({ startupTimeoutMs: mode === 'timeout' ? 300 : 5000, readinessIntervalMs: 20,
    backendCommand: { bin: process.execPath, args: ['-e', mode === 'exit' ? 'process.exit(7)' : 'setInterval(()=>{},1000)'] },
    frontendCommand: { bin: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] },
  });
  const abort = new AbortController();
  try {
    const pending = manager.startServers({ issueIid: 1, branchName: 'demo', workDir: directory, gitRootDir: directory }, ports, abort.signal);
    const rejected = expect(pending).rejects.toThrow(mode === 'timeout' ? '未就绪' : mode === 'cancel' ? '用户暂停' : /取消|退出|停止/);
    if (mode === 'immediate-stop') manager.stopAll();
    if (mode === 'cancel') { await new Promise(resolve => setTimeout(resolve, 150)); abort.abort(new Error('用户暂停')); }
    await rejected;
    await manager.stopAllAndWait();
    expect(manager.getRunningIssues()).toEqual([]);
    expect(manager.getStatus(1).running).toBe(false);
  } finally { await manager.stopAllAndWait(); vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true }); }
});
