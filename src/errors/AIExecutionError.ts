import { AppError } from './BaseError.js';

export class AIExecutionError extends AppError {
  public readonly phase: string;
  public readonly output?: string;
  public readonly exitCode?: number | null;
  public readonly isRetryable: boolean;
  /** Agent was still actively producing output when timeout fired — soft failure */
  public readonly wasActiveAtTimeout: boolean;

  constructor(
    phase: string,
    message: string,
    opts?: {
      output?: string;
      exitCode?: number | null;
      cause?: Error;
      isRetryable?: boolean;
      wasActiveAtTimeout?: boolean;
    },
  ) {
    super('AI_EXECUTION_ERROR', message, opts?.cause);
    this.phase = phase;
    this.output = opts?.output;
    this.exitCode = opts?.exitCode;
    this.isRetryable = opts?.isRetryable ?? true;
    this.wasActiveAtTimeout = opts?.wasActiveAtTimeout ?? false;
  }
}
