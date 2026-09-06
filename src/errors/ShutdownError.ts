import { AppError } from './BaseError.js';

export class ServiceShutdownError extends AppError {
  constructor() {
    super('SERVICE_SHUTDOWN', 'Service shutting down');
  }
}
