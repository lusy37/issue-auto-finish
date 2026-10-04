import { Router } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../src/errors/BaseError.js';
import { createApp } from '../../src/web/createApp.js';

let server: Server;
let base: string;
beforeAll(async () => {
  const router = Router();
  router.get('/errors/:code', (req, _res) => {
    if (req.params.code === 'zod') z.string().parse(123);
    if (req.params.code === 'io') throw new Error('磁盘写入失败');
    throw new AppError(String(req.params.code), '领域错误');
  });
  server = createApp(undefined, [router]).listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务未启动');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

it.each([
  ['zod', 400], ['INVALID_CONFIG', 400], ['FEATURE_DISABLED', 400],
  ['ISSUE_NOT_FOUND', 404], ['INVALID_STATE', 409], ['SERVICE_SHUTDOWN', 503],
  ['AI_EXECUTION_ERROR', 500], ['io', 500],
])('错误 %s 返回 %s，服务端失败不误报为用户输入错误', async (code, status) => {
  const response = await fetch(`${base}/errors/${code}`);
  expect(response.status).toBe(status);
  expect(await response.json()).toHaveProperty('error');
});
