import { it, expect } from 'vitest';
import http from 'node:http';
import { waitForReadiness } from '../../src/preview/readiness.js';

it('实际分配端口立即通过 TCP；HTTP 等待有效响应，支持超时与取消', async () => {
  let ready = false;
  const server = http.createServer((_req, res) => { res.statusCode = ready ? 200 : 503; res.end('状态'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const signal = new AbortController().signal;
  const target = { port, url: 'http://127.0.0.1:{port}/ready' };
  try {
    await waitForReadiness([{ port }], 2000, 10, signal);
    await expect(waitForReadiness([target], 150, 10, signal)).rejects.toThrow('未就绪');
    const timer = setTimeout(() => { ready = true; }, 120);
    try { await waitForReadiness([target], 2000, 10, signal); } finally { clearTimeout(timer); }
    ready = false;
    const abort = new AbortController();
    const waiting = waitForReadiness([target], 2000, 10, abort.signal);
    abort.abort(new Error('用户暂停'));
    await expect(waiting).rejects.toThrow('用户暂停');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
