import { Router } from 'express';
import type { DistillScheduler } from '../../distill/DistillScheduler.js';
import type { DiaryStore } from '../../distill/DiaryStore.js';
import type { Config } from '../../config.js';
export function createDistillRouter(deps: {
  config: Config;
  diaryStore: DiaryStore;
  distillScheduler?: DistillScheduler;
}) {
  const router = Router();
  router.get('/api/distill/status', (_req, res) =>
    res.json({
      status: {
        ...deps.distillScheduler?.getStatus(),
        enabled: deps.config.distill.enabled && !!deps.distillScheduler,
      },
    }),
  );
  router.get('/api/distill/diaries', (_req, res) =>
    res.json({
      diaries: deps.diaryStore.getDisplayable(),
      total: deps.diaryStore.displayableCount(),
    }),
  );
  router.post('/api/distill/run', async (_req, res, next) => {
    try {
      if (!deps.config.distill.enabled) throw new Error('经验蒸馏已关闭，请在设置中开启并重启服务');
      if (!deps.distillScheduler) throw new Error('蒸馏组件未初始化');
      res.json(await deps.distillScheduler.runDistill({ force: true }));
    } catch (err) {
      next(err);
    }
  });
  return router;
}
