import { Router } from 'express';
import type { IssueTracker } from '../../tracker/IssueTracker.js';
import type { Config } from '../../config.js';
import { summarizeTasks } from '../../analytics/TaskAnalytics.js';
export function createAnalyticsRouter(tracker: IssueTracker, _config: Config) {
  const router = Router();
  router.get('/api/analytics/summary', (req, res) => {
    const range = String(req.query.range ?? '7d');
    if (!['7d', '30d', 'all'].includes(range)) {
      res.status(400).json({ error: '统计范围无效' });
      return;
    }
    res.json(summarizeTasks(tracker.getAll(), range as '7d' | '30d' | 'all'));
  });
  return router;
}
