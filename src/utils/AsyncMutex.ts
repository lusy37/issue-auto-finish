/** 进程内局部互斥；等待者取消时立即撤销排队，不影响当前持锁者。 */
export class AsyncMutex {
  private queue: Array<{ grant: () => void; cancel: () => void }> = [];
  private locked = false;
  async runExclusive<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try { signal?.throwIfAborted(); return await fn(); }
    finally { this.release(); }
  }
  private acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.locked) { this.locked = true; return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        grant: () => { signal?.removeEventListener('abort', waiter.cancel); resolve(); },
        cancel: () => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(signal?.reason ?? new Error('等待锁已取消'));
        },
      };
      this.queue.push(waiter);
      signal?.addEventListener('abort', waiter.cancel, { once: true });
    });
  }
  private release(): void {
    const next = this.queue.shift();
    if (next) next.grant(); else this.locked = false;
  }
  get isLocked(): boolean { return this.locked; }
  get queueLength(): number { return this.queue.length; }
}
