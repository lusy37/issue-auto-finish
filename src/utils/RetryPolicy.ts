import { logger as rootLogger } from '../logger.js';

const logger = rootLogger.child('RetryPolicy');

export interface RetryPolicyOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in ms (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay in ms (default: 30000) */
  maxDelayMs?: number;
  /** Jitter factor 0-1 (default: 0.2) */
  jitterFactor?: number;
  /** Function to determine if error is retryable */
  isRetryable?: (error: unknown) => boolean;
  /** Override base delay per-error (e.g. longer backoff for 429). Falls back to baseDelayMs. */
  getBaseDelay?: (error: unknown) => number | undefined;
}

export class RetryPolicy {
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterFactor: number;
  private readonly isRetryable: (error: unknown) => boolean;
  private readonly getBaseDelay: (error: unknown) => number | undefined;

  constructor(options?: RetryPolicyOptions) {
    this.maxRetries = options?.maxRetries ?? 3;
    this.baseDelayMs = options?.baseDelayMs ?? 1000;
    this.maxDelayMs = options?.maxDelayMs ?? 30000;
    this.jitterFactor = options?.jitterFactor ?? 0.2;
    this.isRetryable = options?.isRetryable ?? (() => true);
    this.getBaseDelay = options?.getBaseDelay ?? (() => undefined);
  }

  /** Execute fn with retry. Returns the result or throws the last error. */
  async execute<T>(fn: () => Promise<T>, context?: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt >= this.maxRetries || !this.isRetryable(err)) {
          throw err;
        }
        const delay = this.calculateDelay(attempt, err);
        logger.warn('Retrying after error', {
          context,
          attempt: attempt + 1,
          maxRetries: this.maxRetries,
          delayMs: delay,
          error: (err as Error).message,
        });
        await this.sleep(delay);
      }
    }
    throw lastError; // unreachable but satisfies TS
  }

  private calculateDelay(attempt: number, err?: unknown): number {
    const overrideBase = err ? this.getBaseDelay(err) : undefined;
    const base = overrideBase ?? this.baseDelayMs;
    const exponential = base * Math.pow(2, attempt);
    const capped = Math.min(exponential, this.maxDelayMs);
    const jitter = capped * this.jitterFactor * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(capped + jitter));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
