import express, { type RequestHandler } from 'express';
import path from 'node:path';
/** 统一健康检查、静态页面和接口错误响应，供初始工作台与完整装配复用。 */
export function createApp(frontendDir = path.resolve('src/web/frontend/dist'), routers: RequestHandler[] = []) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  for (const router of routers) app.use(router);
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/detail', (_req, res) => res.sendFile(path.resolve(frontendDir,'index.html')));
  app.use(express.static(frontendDir));
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(400).json({ error: error.message }));
  return app;
}
