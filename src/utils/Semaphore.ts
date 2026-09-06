/**
 * 轻量异步信号量：限制同时执行的异步任务数量，超出上限的任务排队等待。
 *
 * 用于对外部 API（如GitHub）做客户端侧并发限流，避免请求风暴触发对端 429 限流。
 * 配额在任务完成（含异常）后自动归还，并直接转移给下一个等待者。
 */
export class Semaphore {
  private readonly max: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    this.max = Math.max(1, Math.floor(max));
  }

  /** 在并发配额内执行 fn；超出上限时排队，完成后自动释放配额（含异常路径）。 */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // 配额直接转移给下一个等待者（active 不变）
      next();
    } else {
      this.active--;
    }
  }
}
