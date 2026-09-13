import fs from 'node:fs';
import path from 'node:path';
import { it, expect } from 'vitest';
import { createApp } from '../../src/web/createApp.js';
it('健康检查返回服务状态', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('服务未启动');
    const response = await fetch('http://127.0.0.1:' + address.port + '/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});


it('隐藏 Worktree 内可以直接打开详情页，隐藏资源仍不可公开访问', async () => {
  const directory = path.join(process.env.DATA_DIR!, '.worktree', 'frontend');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'index.html'), '<main>详情页</main>');
  fs.writeFileSync(path.join(directory, '.private'), '内部文件');
  const server = createApp(directory).listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    const response = await fetch(base + '/detail?issue=1');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<main>详情页</main>');
    expect((await fetch(base + '/.private')).status).toBe(404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
