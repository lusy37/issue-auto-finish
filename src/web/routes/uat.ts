import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '../../paths.js';
import { UAT_FORMAT } from '../../shared/runtime/formats.js';
export function createUatRouter(dataDir = resolveDataDir()) {
  const router = express.Router();
  const root = path.join(dataDir, 'uat');
  router.get('/api/issues/:number/uat-runs', (req, res) => {
    const runs = fs.existsSync(root)
      ? fs.readdirSync(root).flatMap((id) => {
          try {
            if (!/^[a-f0-9-]{36}$/.test(id)) return [];
            const result = JSON.parse(fs.readFileSync(path.join(root, id, 'summary.json'), 'utf8'));
            return result.format === UAT_FORMAT
              && result.runId === id
              && result.issueIid === Number(req.params.number)
              ? [result]
              : [];
          } catch {
            return [];
          }
        })
      : [];
    res.json({
      runs: runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    });
  });
  router.use('/api/uat/runs/:runId/files', (req, res, next) => {
    const runId = String(req.params.runId);
    if (!/^[a-f0-9-]{36}$/.test(runId)) {
      res.sendStatus(400);
      return;
    }
    const runRoot = path.resolve(root, runId);
    const requested = path.resolve(runRoot, '.' + req.path);
    if (requested !== runRoot && !requested.startsWith(runRoot + path.sep)) {
      res.sendStatus(400);
      return;
    }
    let current = runRoot;
    for (const segment of path.relative(runRoot, requested).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          res.sendStatus(404);
          return;
        }
      } catch {
        // 静态中间件会返回 404。
      }
    }
    express.static(runRoot, {
      dotfiles: 'deny',
    })(req, res, next);
  });
  return router;
}
