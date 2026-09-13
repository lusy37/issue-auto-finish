import { describe, it, expect } from 'vitest';
import { AsyncMutex } from '../../src/utils/AsyncMutex.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('AsyncMutex', () => {
  it('executes a single task without contention', async () => {
    const mutex = new AsyncMutex();
    const result = await mutex.runExclusive(async () => 42);
    expect(result).toBe(42);
    expect(mutex.isLocked).toBe(false);
  });

  it('serializes concurrent tasks in FIFO order', async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];

    const p1 = mutex.runExclusive(async () => {
      await delay(30);
      order.push(1);
    });
    const p2 = mutex.runExclusive(async () => {
      await delay(10);
      order.push(2);
    });
    const p3 = mutex.runExclusive(async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('releases lock even when the task throws', async () => {
    const mutex = new AsyncMutex();

    await expect(
      mutex.runExclusive(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(mutex.isLocked).toBe(false);

    const result = await mutex.runExclusive(async () => 'ok');
    expect(result).toBe('ok');
  });

  it('reports correct queueLength', async () => {
    const mutex = new AsyncMutex();
    let resolveFirst!: () => void;
    const blockingPromise = new Promise<void>((r) => { resolveFirst = r; });

    const p1 = mutex.runExclusive(() => blockingPromise);
    await delay(0);

    expect(mutex.isLocked).toBe(true);
    expect(mutex.queueLength).toBe(0);

    const p2 = mutex.runExclusive(async () => {});
    const p3 = mutex.runExclusive(async () => {});
    expect(mutex.queueLength).toBe(2);

    resolveFirst();
    await Promise.all([p1, p2, p3]);

    expect(mutex.isLocked).toBe(false);
    expect(mutex.queueLength).toBe(0);
  });

  it('prevents interleaved read-modify-write', async () => {
    const mutex = new AsyncMutex();
    let counter = 0;

    const increment = () =>
      mutex.runExclusive(async () => {
        const current = counter;
        await delay(5);
        counter = current + 1;
      });

    await Promise.all(Array.from({ length: 10 }, () => increment()));
    expect(counter).toBe(10);
  });
});

it('取消等待中的 Git 锁不会执行回调，也不会释放别人的锁', async () => {
  const mutex = new AsyncMutex();
  let release!: () => void;
  const held = mutex.runExclusive(() => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve();
  const controller = new AbortController();
  let called = false;
  const waiting = mutex.runExclusive(async () => { called = true; }, controller.signal);
  controller.abort(new Error('已取消'));
  await expect(waiting).rejects.toThrow('已取消');
  expect(mutex.queueLength).toBe(0); expect(mutex.isLocked).toBe(true);
  release(); await held;
  expect(called).toBe(false); expect(mutex.isLocked).toBe(false);
});
