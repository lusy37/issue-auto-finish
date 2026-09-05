/**
 * AsyncLocalStorage-based request-level context for issue processing.
 *
 * Allows any code within the call chain of `runWithIssueContext()` to
 * retrieve the current issue IID and correlation ID without explicit
 * parameter passing.  The logger automatically injects `[issue:N]`
 * when running inside a context.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface IssueCtx {
  /** GitHub issue IID being processed. */
  issueIid: number;
  /** Unique correlation ID for this processing run. */
  correlationId: string;
}

/** Shared store – one per process. */
export const issueContext = new AsyncLocalStorage<IssueCtx>();

/**
 * Run `fn` within an issue-scoped context.
 * A new `correlationId` is generated automatically.
 */
export function runWithIssueContext<T>(number: number, fn: () => T): T {
  return issueContext.run(
    { issueIid: number, correlationId: randomUUID() },
    fn,
  );
}

/**
 * Retrieve the current issue context, or `undefined` if not inside one.
 */
export function getIssueContext(): IssueCtx | undefined {
  return issueContext.getStore();
}
