import { EventEmitter } from 'node:events';

export type EventType =
  | 'issue:created'
  | 'issue:stateChanged'
  | 'issue:failed'
  | 'issue:deleted'
  | 'issue:resetForRetry'
  | 'issue:restarted'
  | 'issue:retryFromPhase'
  | 'poll:tick'
  | 'heartbeat'
  | 'agent:output'
  | 'pipeline:progress'
  | 'conflict:started'
  | 'conflict:resolved'
  | 'conflict:failed'
  // Distill events
  | 'distill:diary:created'
  | 'distill:started'
  | 'distill:memory:updated'
  | 'distill:rule:generated'
  | 'distill:completed'
  | 'distill:failed'
  // Verify-fix loop events
  | 'verify:loopStarted'
  | 'verify:iterationComplete'
  | 'verify:loopExhausted'
  // UAT async events
  | 'uat:completed'
  | 'uat:failed'
  // Phase abort/continue/redo events
  | 'issue:paused'
  | 'issue:continued'
  | 'issue:redone'
  // Preview reaper events
  | 'preview:reaped'
  // Agent interactive dialog events
  // Orchestration / Reducer events (PR3+)
  | 'pipeline:completed'
  | 'pipeline:failed'
  | 'phase:failed'
  | 'phase:retryFrom'
  | 'phase:retryFromExhausted'
  | 'gate:requested'
  | 'gate:approved'
  | 'gate:rejected'
  | 'gate:supplemented';

export interface EventPayload {
  type: EventType;
  data: unknown;
  timestamp: string;
}

/**
 * Typed event bus based on EventEmitter.
 *
 * Exported as a class so consumers can receive an instance via dependency
 * injection instead of relying on the global singleton.
 */
export class EventBus extends EventEmitter {
  emit(event: string | symbol, ...args: unknown[]): boolean {
    super.emit('*', event, ...args);
    return super.emit(event, ...args);
  }

  emitTyped(type: EventType, data: unknown): void {
    const payload: EventPayload = {
      type,
      data,
      timestamp: new Date().toISOString(),
    };
    this.emit(type, payload);
  }
}


export const eventBus = new EventBus();
