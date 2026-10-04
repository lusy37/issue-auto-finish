import { Router } from 'express';
import { booleanSettingSchema } from '../RequestContracts.js';
import { z } from 'zod';
import type { KnowledgeStore } from '../../knowledge/KnowledgeStore.js';
import { VersionStore } from '../../distill/VersionStore.js';
import path from 'node:path';
import { resolveDataDir } from '../../paths.js';
import { readProjectProfile, writeProjectProfile } from '../../knowledge/ProjectProfile.js';
const contentSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(100000),
  tags: z.array(z.string()).optional(),
});

// 存储的是完整记忆/规则；展示仅提取需要的字段，允许 id、版本等存储元数据。
const memoryContentSchema = z.object({
  content: z.string(),
  confidence: z.number(),
  evidence: z.array(z.string()),
});
const ruleContentSchema = z.object({
  content: z.string(),
  deprecated: z.boolean(),
});

function toApiEntry(entry: ReturnType<KnowledgeStore['get']>) {
  if (!entry || (entry.type !== 'memory' && entry.type !== 'agent-rule')) return entry;
  if (entry.type === 'memory') {
    const parsed = memoryContentSchema.parse(JSON.parse(entry.content));
    return {
      ...entry,
      content: parsed.content,
      memory: { confidence: parsed.confidence, evidence: parsed.evidence },
    };
  }
  const parsed = ruleContentSchema.parse(JSON.parse(entry.content));
  return { ...entry, content: parsed.content, deprecated: parsed.deprecated };
}
export function createKnowledgeRouter(store: KnowledgeStore) {
  const router = Router();
  router.get('/api/project-profile', (_req, res) => res.json(readProjectProfile()));
  router.put('/api/project-profile', (req, res) => {
    res.json(writeProjectProfile(req.body));
  });
  router.get('/api/knowledge', (_req, res) =>
    res.json({
      entries: store.getAllEntries().map((entry) => toApiEntry(entry)),
      stats: store.getStats(),
    }),
  );
  router.post('/api/knowledge', (req, res) => {
    res.json(toApiEntry(store.create({ ...contentSchema.parse(req.body), type: 'custom' })));
  });
  router.put('/api/knowledge/:id', (req, res) => {
    const item = store.update(String(req.params.id), contentSchema.partial().parse(req.body));
    if (!item) {
      res.sendStatus(404);
      return;
    }
    res.json(toApiEntry(item));
  });
  router.put('/api/knowledge/:id/enabled', (req, res) => {
    const { enabled } = booleanSettingSchema.parse(req.body);
    const item = store.get(String(req.params.id));
    if (!item || item.type !== 'agent-rule') {
      res.sendStatus(404);
      return;
    }
    const tags = item.tags.filter((t) => t !== 'enabled');
    if (enabled) tags.push('enabled');
    res.json(toApiEntry(store.update(item.id, { tags })));
  });
  router.get('/api/knowledge/:id/versions', (req, res) =>
    res.json({
      versions: new VersionStore(path.join(resolveDataDir(), 'distill')).getByEntryId(
        (() => {
          const item = store.get(String(req.params.id));
          try {
            return JSON.parse(item?.content ?? '{}').id ?? String(req.params.id);
          } catch {
            return String(req.params.id);
          }
        })(),
      ),
    }),
  );
  router.delete('/api/knowledge/:id', (req, res) =>
    res.json({ success: store.delete(String(req.params.id)) }),
  );
  return router;
}
