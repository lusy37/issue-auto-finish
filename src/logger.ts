import { getIssueContext } from './context/IssueContext.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private level: LogLevel = 'info';
  private context?: string;

  constructor(context?: string) {
    this.context = context;
    const envLevel = process.env.LOG_LEVEL as LogLevel | undefined;
    if (envLevel && envLevel in LOG_LEVELS) {
      this.level = envLevel;
    }
  }

  child(context: string): Logger {
    const child = new Logger(this.context ? `${this.context}:${context}` : context);
    child.level = this.level;
    return child;
  }

  private format(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
    const ts = new Date().toISOString();
    const prefix = this.context ? `[${this.context}]` : '';

    // Auto-inject issue context from AsyncLocalStorage
    const issueCtx = getIssueContext();
    const issueTag = issueCtx ? ` [issue:${issueCtx.issueIid}]` : '';

    const metaObj = issueCtx ? { ...meta, correlationId: issueCtx.correlationId } : meta;
    const metaStr = metaObj && Object.keys(metaObj).length > 0 ? ` ${JSON.stringify(metaObj)}` : '';
    return `${ts} ${level.toUpperCase().padEnd(5)} ${prefix}${issueTag} ${message}${metaStr}`;
  }

  private log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.level]) return;
    const line = this.format(level, message, meta);
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.log('error', message, meta);
  }
}

export const logger = new Logger();
export { Logger };
