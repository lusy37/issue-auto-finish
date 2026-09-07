import express from "express";
import fs from "node:fs";
import path from "node:path";
import { resolveDataDir } from "../../paths.js";
export function createUatRouter() {
  const router = express.Router();
  const root = path.join(resolveDataDir(), "uat");
  router.get("/api/issues/:number/uat-runs", (req, res) => {
    const runs = fs.existsSync(root)
      ? fs.readdirSync(root).flatMap((id) => {
          try {
            const result = JSON.parse(
              fs.readFileSync(path.join(root, id, "summary.json"), "utf8"),
            );
            return result.issueIid === Number(req.params.number) ? [result] : [];
          } catch {
            return [];
          }
        })
      : [];
    res.json({
      runs: runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    });
  });
  router.use("/api/uat/runs/:runId/files", (req, res, next) => {
    if (!/^[a-f0-9-]{36}$/.test(String(req.params.runId))) {
      res.sendStatus(400);
      return;
    }
    express.static(path.join(root, String(req.params.runId)), {
      dotfiles: "deny",
    })(req, res, next);
  });
  return router;
}
