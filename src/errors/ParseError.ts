import { AppError } from './BaseError.js';

export class AIOutputParseError extends AppError {
  public readonly rawOutput?: string;
  constructor(message: string, rawOutput?: string) {
    super('AI_OUTPUT_PARSE_ERROR', message);
    this.rawOutput = rawOutput;
  }
}
