import express, { type RequestHandler } from 'express';
import path from 'node:path';
import { ZodError } from 'zod';
import { AppError } from '../errors/BaseError.js';
import { GateActionError } from '../orchestration/index.js';

const domainStatus: Record<string, number> = {
  ISSUE_NOT_FOUND: 404,
  INVALID_CONFIG: 400,
  INVALID_PHASE: 400,
  INVALID_STATE: 409,
  FEATURE_DISABLED: 400,
  SERVICE_SHUTDOWN: 503,
};
/** 统一健康检查、静态页面和接口错误响应，供初始工作台与完整装配复用。 */
export function createApp(
  frontendDir = path.resolve('src/web/frontend/dist'),
  routers: RequestHandler[] = [],
) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  for (const router of routers) app.use(router);
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  // 静态根目录可能位于隐藏 Worktree 中；只在明确的公开目录内解析页面。
  app.get('/detail', (_req, res) =>
    res.sendFile('index.html', { root: path.resolve(frontendDir) }),
  );
  app.use(express.static(frontendDir));
  app.use(
    (error: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (res.headersSent) { next(error); return; }
      const status = error instanceof ZodError ? 400
        : error instanceof GateActionError ? 409
          : error instanceof AppError ? (domainStatus[error.code] ?? 500)
            : 'status' in error && typeof error.status === 'number' ? error.status : 500;
      res.status(status).json({ error: error.message });
    },
  );
  return app;
}
