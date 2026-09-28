import { Router } from 'express';
import path from 'node:path';
import type { AIRunner } from '../../ai-runner/AIRunner.js';
import type { GitHubClient } from '../../clients/GitHubClient.js';
import type { Config } from '../../config.js';
import { resolveDataDir } from '../../paths.js';
import { DraftService } from '../../demand/DraftService.js';
export function createDraftRouter(runner: AIRunner, client: GitHubClient, config: Config) {
  const router = Router(),
    service = new DraftService(
      path.join(resolveDataDir(), 'drafts'),
      runner,
      client,
      config.project.workDir,
      client.repositoryUrl,
    );
  router.get('/api/drafts', (_req, res) => res.json({ drafts: service.list() }));
  router.post('/api/drafts', async (req, res, next) => {
    try {
      res.json(await service.generate(String(req.body.input ?? '')));
    } catch (e) {
      next(e);
    }
  });
  router.put('/api/drafts/:id', async (req, res, next) => {
    try {
      res.json(await service.edit(String(req.params.id), req.body));
    } catch (e) {
      next(e);
    }
  });
  router.post('/api/drafts/:id/confirm', async (req, res, next) => {
    try {
      res.json(await service.confirm(String(req.params.id)));
    } catch (e) {
      next(e);
    }
  });
  router.post('/api/drafts/:id/reconcile', async (req, res, next) => {
    try {
      res.json(await service.reconcile(String(req.params.id), req.body.issueIid ?? null));
    } catch (e) {
      next(e);
    }
  });
  return router;
}
