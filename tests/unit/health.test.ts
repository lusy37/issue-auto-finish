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
