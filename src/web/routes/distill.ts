import { Router } from "express";
import type { DistillScheduler } from "../../distill/DistillScheduler.js";
import type { DiaryStore } from "../../distill/DiaryStore.js";
import type { Config } from "../../config.js";
export function createDistillRouter(deps: {
  config: Config;
  diaryStore: DiaryStore;
  distillScheduler?: DistillScheduler;
}) {
  const router = Router();
  router.get("/api/distill/status", (_req, res) =>
    res.json({ status: deps.distillScheduler?.getStatus() }),
  );
  router.get("/api/distill/diaries", (_req, res) =>
    res.json({
      diaries: deps.diaryStore.getAll(),
      total: deps.diaryStore.count(),
    }),
  );
  router.post("/api/distill/run", async (_req, res, next) => {
    try {
      if (!deps.distillScheduler) throw new Error("蒸馏组件未初始化");
      res.json(await deps.distillScheduler.runDistill({ force: true }));
    } catch (err) {
      next(err);
    }
  });
  return router;
}
