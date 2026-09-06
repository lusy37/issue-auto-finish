import { describe, it, expect } from 'vitest';
import { Semaphore } from '../../src/utils/Semaphore.js';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('Semaphore', () => {
  it('limits concurrency to the configured maximum', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const gate: Array<() => void> = [];

    const start = (id: number): Promise<number> =>
      sem.run(
        () =>
          new Promise<number>((resolve) => {
            active++;
            peak = Math.max(peak, active);
            gate.push(() => {
              active--;
              resolve(id);
            });
          }),
      );

    const tasks = [start(1), start(2), start(3), start(4)];

    // 仅 2 个能进入临界区，其余排队
    await flush();
    expect(peak).toBe(2);
    expect(gate).toHaveLength(2);

    // 逐个释放，每次释放恰好放行一个等待者
    while (gate.length > 0) {
      gate.shift()!();
      await flush();
    }

    const results = await Promise.all(tasks);
    expect(results.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it('runs queued tasks and returns each result', async () => {
    const sem = new Semaphore(1);
    const results = await Promise.all([
      sem.run(async () => 'a'),
      sem.run(async () => 'b'),
      sem.run(async () => 'c'),
    ]);
    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('releases the slot even when a task throws', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // 槽位应已释放，后续任务仍能执行
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });
});
