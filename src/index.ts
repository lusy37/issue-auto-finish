import express from 'express';
import path from 'node:path';
export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use(express.static(path.resolve('src/web/frontend/dist')));
  return app;
}
export async function main(): Promise<void> {
  const port = Number(process.env.WEB_PORT || 3000);
  const server = createApp().listen(port, '127.0.0.1', () => console.log('工作台：http://127.0.0.1:' + port));
  process.once('SIGINT', () => server.close());
  process.once('SIGTERM', () => server.close());
}
