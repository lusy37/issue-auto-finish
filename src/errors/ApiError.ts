import { GITHUB_MAX_AUTO_WAIT_MS } from './GitHubPolicy.js';
import { AppError } from './BaseError.js';

export class GitHubApiError extends AppError {
  public readonly statusCode: number;
  public readonly responseBody?: string;

  constructor(
    statusCode: number,
    message: string,
    responseBody?: string,
    private readonly rateLimited = false,
    public readonly retryAfterMs?: number,
  ) {
    super('GITHUB_API_ERROR', message);
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }

  /** Whether this error is potentially retryable (5xx, 429, or network). */
  get isRetryable(): boolean {
    return this.isRateLimited
      ? (this.retryAfterMs ?? 60000) <= GITHUB_MAX_AUTO_WAIT_MS
      : this.statusCode >= 500 || this.statusCode === 0;
  }

  /** Rate-limited responses should not trip the circuit breaker. */
  get isRateLimited(): boolean {
    return this.rateLimited || this.statusCode === 429;
  }
}
