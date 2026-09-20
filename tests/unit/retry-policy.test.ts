import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RetryPolicy } from '../../src/utils/RetryPolicy.js';

// Suppress logger output in tests
vi.mock('../../src/logger.js', () => ({
  logger: {
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

describe('RetryPolicy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns result on first success without retry', async () => {
    const policy = new RetryPolicy({ maxRetries: 3 });
    const fn = vi.fn().mockResolvedValue('ok');

    const result = await policy.execute(fn, 'test');

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable error and succeeds', async () => {
    const policy = new RetryPolicy({
      maxRetries: 3,
      baseDelayMs: 1,
      isRetryable: () => true,
    });
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'))
      .mockResolvedValue('recovered');

    const result = await policy.execute(fn, 'test');

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting maxRetries', async () => {
    const policy = new RetryPolicy({
      maxRetries: 2,
      baseDelayMs: 1,
      isRetryable: () => true,
    });
    const fn = vi.fn().mockRejectedValue(new Error('persistent-failure'));

    await expect(policy.execute(fn, 'test')).rejects.toThrow('persistent-failure');
    // 1 initial + 2 retries = 3 total
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-retryable errors', async () => {
    const policy = new RetryPolicy({
      maxRetries: 3,
      baseDelayMs: 1,
      isRetryable: () => false,
    });
    const fn = vi.fn().mockRejectedValue(new Error('non-retryable'));

    await expect(policy.execute(fn, 'test')).rejects.toThrow('non-retryable');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses custom isRetryable predicate', async () => {
    const retryableError = new Error('retryable');
    Object.assign(retryableError, { retryable: true });
    const nonRetryableError = new Error('non-retryable');

    const policy = new RetryPolicy({
      maxRetries: 3,
      baseDelayMs: 1,
      isRetryable: (err) => (err as Record<string, unknown>).retryable === true,
    });

    // Non-retryable should fail immediately
    const fn1 = vi.fn().mockRejectedValue(nonRetryableError);
    await expect(policy.execute(fn1, 'test')).rejects.toThrow('non-retryable');
    expect(fn1).toHaveBeenCalledTimes(1);

    // Retryable should retry
    const fn2 = vi.fn()
      .mockRejectedValueOnce(retryableError)
      .mockResolvedValue('ok');
    const result = await policy.execute(fn2, 'test');
    expect(result).toBe('ok');
    expect(fn2).toHaveBeenCalledTimes(2);
  });

  describe('exponential backoff', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('applies exponential backoff delays', async () => {
      const delays: number[] = [];

      // Intercept setTimeout calls to record delays, then immediately resolve
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        if (ms !== undefined && ms > 0) {
          delays.push(ms);
        }
        // Immediately invoke callback
        if (typeof fn === 'function') {
          Promise.resolve().then(fn);
        }
        return 0 as unknown as NodeJS.Timeout;
      }) as typeof globalThis.setTimeout);

      const policy = new RetryPolicy({
        maxRetries: 3,
        baseDelayMs: 100,
        maxDelayMs: 10000,
        jitterFactor: 0, // No jitter for predictable delays
        isRetryable: () => true,
      });

      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue('ok');

      await policy.execute(fn, 'test');

      // With jitterFactor=0: attempt 0 -> 100ms, attempt 1 -> 200ms
      expect(delays).toEqual([100, 200]);
    });

    it('caps delay at maxDelayMs', async () => {
      const delays: number[] = [];

      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        if (ms !== undefined && ms > 0) {
          delays.push(ms);
        }
        if (typeof fn === 'function') {
          Promise.resolve().then(fn);
        }
        return 0 as unknown as NodeJS.Timeout;
      }) as typeof globalThis.setTimeout);

      const policy = new RetryPolicy({
        maxRetries: 5,
        baseDelayMs: 10000,
        maxDelayMs: 15000,
        jitterFactor: 0,
        isRetryable: () => true,
      });

      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail'))  // attempt 0: 10000 * 2^0 = 10000
        .mockRejectedValueOnce(new Error('fail'))  // attempt 1: 10000 * 2^1 = 20000 -> capped to 15000
        .mockResolvedValue('ok');

      await policy.execute(fn, 'test');

      expect(delays[0]).toBe(10000);
      expect(delays[1]).toBe(15000);

      for (const delay of delays) {
        expect(delay).toBeLessThanOrEqual(15000);
      }
    });
  });

  it('works with zero maxRetries (no retries)', async () => {
    const policy = new RetryPolicy({
      maxRetries: 0,
      isRetryable: () => true,
    });

    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    await expect(policy.execute(fn)).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('defaults isRetryable to always true', async () => {
    // Use fake timers to avoid real delay
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, _ms?: number) => {
      if (typeof fn === 'function') {
        Promise.resolve().then(fn);
      }
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof globalThis.setTimeout);

    const policy = new RetryPolicy({
      maxRetries: 1,
    });

    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('err'))
      .mockResolvedValue('ok');

    const result = await policy.execute(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});
