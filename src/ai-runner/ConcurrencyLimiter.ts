/** 可取消的 FIFO 额度；排队请求不启动进程，也不占用 Git 锁。 */
export class ConcurrencyLimiter {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error('AI 并发必须为 1～32');
  }
  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal?.removeEventListener('abort', abort);
        this.active++;
        resolve();
      };
      const abort = () => {
        this.queue = this.queue.filter(entry => entry !== start);
        reject(new Error('等待 AI 额度时已取消'));
      };
      if (this.active < this.limit) start();
      else {
        this.queue.push(start);
        signal?.addEventListener('abort', abort, { once: true });
      }
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.queue.shift()?.();
    };
  }
  get running(): number { return this.active; }
  get waiting(): number { return this.queue.length; }
}
