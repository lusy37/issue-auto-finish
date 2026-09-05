import { describe, it, expect, vi } from 'vitest';
import {
  runWithIssueContext,
  getIssueContext,
  issueContext,
} from '../../src/context/IssueContext.js';

describe('IssueContext', () => {
  it('returns undefined outside a context', () => {
    expect(getIssueContext()).toBeUndefined();
  });

  it('provides issueIid inside runWithIssueContext', () => {
    runWithIssueContext(42, () => {
      const ctx = getIssueContext();
      expect(ctx).toBeDefined();
      expect(ctx!.issueIid).toBe(42);
      expect(ctx!.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  it('returns undefined after context exits', () => {
    runWithIssueContext(1, () => {
      // inside
    });
    expect(getIssueContext()).toBeUndefined();
  });

  it('isolates parallel contexts', async () => {
    const results: number[] = [];

    await Promise.all([
      new Promise<void>((resolve) => {
        runWithIssueContext(10, () => {
          // Simulate async work
          setTimeout(() => {
            const ctx = getIssueContext();
            results.push(ctx!.issueIid);
            resolve();
          }, 10);
        });
      }),
      new Promise<void>((resolve) => {
        runWithIssueContext(20, () => {
          setTimeout(() => {
            const ctx = getIssueContext();
            results.push(ctx!.issueIid);
            resolve();
          }, 5);
        });
      }),
    ]);

    expect(results).toContain(10);
    expect(results).toContain(20);
    expect(results).toHaveLength(2);
  });

  it('generates unique correlationIds per run', () => {
    const ids: string[] = [];
    runWithIssueContext(1, () => {
      ids.push(getIssueContext()!.correlationId);
    });
    runWithIssueContext(1, () => {
      ids.push(getIssueContext()!.correlationId);
    });
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('works with async functions', async () => {
    const result = await runWithIssueContext(99, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return getIssueContext()!.issueIid;
    });
    expect(result).toBe(99);
  });
});
