import { AppError } from './BaseError.js';

export class InvalidPhaseError extends AppError {
  public readonly phase: string;
  constructor(phase: string, message?: string) {
    super('INVALID_PHASE', message ?? `Invalid phase for retry: ${phase}`);
    this.phase = phase;
  }
}

export class InvalidStateError extends AppError {
  public readonly state: string;
  constructor(state: string, message?: string) {
    super('INVALID_STATE', message ?? `Invalid state: ${state}`);
    this.state = state;
  }
}

export class PortExhaustionError extends AppError {
  constructor(message?: string) {
    super('PORT_EXHAUSTION', message ?? 'No available ports in the configured range');
  }
}

export class SessionLimitError extends AppError {
  public readonly limit: number;
  constructor(limit: number) {
    super('SESSION_LIMIT', `Session message limit reached (${limit})`);
    this.limit = limit;
  }
}
