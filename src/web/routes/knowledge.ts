import { Router } from "express";
import { z } from "zod";
import type { KnowledgeStore } from "../../knowledge/KnowledgeStore.js";
import { VersionStore } from "../../distill/VersionStore.js";
import path from "node:path";
import { resolveDataDir } from "../../paths.js";
import {
  readProjectProfile,
  writeProjectProfile,
} from "../../knowledge/ProjectProfile.js";
const contentSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(100000),
  tags: z.array(z.string()).optional(),
});
export function createKnowledgeRouter(store: KnowledgeStore) {
  const router = Router();
  router.get("/api/project-profile", (_req, res) =>
    res.json(readProjectProfile()),
  );
  router.put("/api/project-profile", (req, res, next) => {
    try {
      res.json(writeProjectProfile(req.body));
    } catch (e) {
      next(e);
    }
  });
  router.get("/api/knowledge", (_req, res) =>
    res.json({ entries: store.getAllEntries(), stats: store.getStats() }),
  );
  router.post("/api/knowledge", (req, res, next) => {
    try {
      res.json(
        store.create({ ...contentSchema.parse(req.body), type: "custom" }),
      );
    } catch (e) {
      next(e);
    }
  });
  router.put("/api/knowledge/:id", (req, res, next) => {
    try {
      const item = store.update(
        String(req.params.id),
        contentSchema.partial().parse(req.body),
      );
      if (!item) {
        res.sendStatus(404);
        return;
      }
      res.json(item);
    } catch (e) {
      next(e);
    }
  });
  router.put("/api/knowledge/:id/enabled", (req, res, next) => {
    try {
      const item = store.get(String(req.params.id));
      if (!item || item.type !== "agent-rule") {
        res.sendStatus(404);
        return;
      }
      const tags = item.tags.filter((t) => t !== "enabled");
      if (req.body.enabled === true) tags.push("enabled");
      res.json(store.update(item.id, { tags }));
    } catch (e) {
      next(e);
    }
  });
  router.get("/api/knowledge/:id/versions", (req, res) =>
    res.json({
      versions: new VersionStore(
        path.join(resolveDataDir(), "distill"),
      ).getByEntryId(
        (() => {
          const item = store.get(String(req.params.id));
          try {
            return (
              JSON.parse(item?.content ?? "{}").id ?? String(req.params.id)
            );
          } catch {
            return String(req.params.id);
          }
        })(),
      ),
    }),
  );
  router.delete("/api/knowledge/:id", (req, res) =>
    res.json({ success: store.delete(String(req.params.id)) }),
  );
  return router;
}
