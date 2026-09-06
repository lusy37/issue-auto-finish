/**
 * Base application error with structured error code and cause chain.
 */
export class AppError extends Error {
  /** Unique error code for programmatic matching (e.g. 'GITHUB_API_ERROR'). */
  public readonly code: string;
  /** Original cause, if any. */
  public override readonly cause?: Error;

  constructor(code: string, message: string, cause?: Error) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.code = code;
    this.cause = cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.cause ? { cause: this.cause.message } : {}),
    };
  }
}
