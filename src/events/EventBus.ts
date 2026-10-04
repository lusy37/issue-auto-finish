import { EventEmitter } from 'node:events';

export type EventType =
  | 'issue:created'
  | 'issue:updated'
  | 'issue:failed'
  | 'issue:deleted'
  | 'issue:resetForRetry'
  | 'issue:restarted'
  | 'issue:retryFromPhase'
  | 'agent:output'
  | 'pipeline:progress'
  // 经验蒸馏
  | 'distill:diary:created'
  | 'distill:started'
  | 'distill:completed'
  // 阶段暂停与继续
  | 'issue:paused'
  | 'issue:continued'
  // 预览回收
  | 'preview:reaped'
  // 审核状态
  | 'gate:approved'
  | 'gate:rejected';

export interface EventPayload {
  type: EventType;
  data: unknown;
  timestamp: string;
}

/** 支持依赖注入的事件总线；通配监听器用于向工作台转发事件。 */
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
