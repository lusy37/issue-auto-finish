import { summarizeAgentEvent, clampAgentSummary } from '../shared/runtime/agentLogs.js';
import type { ExecutionIdentity } from '../dag/contracts.js';
import fs from 'node:fs';
import path from 'node:path';
import { eventBus, EventPayload } from '../events/EventBus.js';
import { logger as rootLogger } from '../logger.js';

const logger = rootLogger.child('AgentLogStore');

export interface AgentLogEntry {
  identity?: ExecutionIdentity;
  type: string;
  phase?: string;
  timestamp: string;
  summary: string;
}

export const MAX_LOGS_PER_ISSUE = 20000;
export const LOG_TRIM_BATCH_SIZE = 1000;

const DEBUG_EVENT_TYPES = new Set([
  'thinking',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_start',
  'message_delta',
  'message_stop',
  'ping',
  'message', // 顶级消息框架 - 含 uuid/session_id 等协议元数据，无文本内容
]);

export class AgentLogStore {
  private logDir: string;
  private counts = new Map<number, number>();

  constructor(dataDir: string) {
    this.logDir = path.join(dataDir, 'agent-logs');
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  public startListening(): void {
    eventBus.on('agent:output', (payload: EventPayload) => {
      this.handleAgentOutput(payload);
    });

    eventBus.on('pipeline:progress', (payload: EventPayload) => {
      this.handlePipelineProgress(payload);
    });

    logger.info('AgentLogStore listening for events');
  }

  public getLogs(issueIid: number): AgentLogEntry[] {
    const filePath = this.logFilePath(issueIid);
    if (!fs.existsSync(filePath)) return [];

    try {
      const raw = fs.readFileSync(filePath, 'utf-8').trim();
      if (!raw) return [];
      return raw
        .split('\n')
        .slice(-MAX_LOGS_PER_ISSUE)
        .map((line) => JSON.parse(line) as AgentLogEntry);
    } catch (err) {
      logger.warn('Failed to read agent logs', { issueIid, error: (err as Error).message });
      return [];
    }
  }

  public clearLogs(issueIid: number): void {
    this.counts.delete(issueIid);
    const filePath = this.logFilePath(issueIid);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  private logFilePath(issueIid: number): string {
    return path.join(this.logDir, `${issueIid}.jsonl`);
  }

  private appendLog(issueIid: number, entry: AgentLogEntry): void {
    const filePath = this.logFilePath(issueIid);
    try {
      let count = this.counts.get(issueIid);
      if (count === undefined) {
        const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').trim() : '';
        count = raw ? raw.split('\n').length : 0;
      }
      fs.appendFileSync(
        filePath,
        `${JSON.stringify({ ...entry, summary: clampAgentSummary(entry.summary) })}\n`,
        'utf-8',
      );
      this.counts.set(issueIid, count + 1);
      if (count + 1 >= MAX_LOGS_PER_ISSUE + LOG_TRIM_BATCH_SIZE)
        this.trimIfNeeded(issueIid, filePath);
    } catch (err) {
      logger.warn('Failed to write agent log', { issueIid, error: (err as Error).message });
    }
  }

  private trimIfNeeded(issueIid: number, filePath: string): void {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8').trim();
      if (!raw) return;
      const lines = raw.split('\n');
      if (lines.length > MAX_LOGS_PER_ISSUE) {
        const trimmed = lines.slice(-MAX_LOGS_PER_ISSUE);
        fs.writeFileSync(filePath, `${trimmed.join('\n')}\n`, 'utf-8');
        this.counts.set(issueIid, trimmed.length);
        logger.info('Agent logs trimmed', { issueIid, from: lines.length, to: trimmed.length });
      }
    } catch {
      // best-effort trimming
    }
  }

  private handleAgentOutput(payload: EventPayload): void {
    const d = payload.data as {
      issueIid?: number;
      phase?: string;
      event?: {
        identity?: ExecutionIdentity;
        type?: string;
        content?: unknown;
        timestamp?: string;
      };
    };
    if (!d?.issueIid || !d.event) return;

    const eventType = d.event.type || 'raw';
    if (DEBUG_EVENT_TYPES.has(eventType)) return;

    const entry: AgentLogEntry = {
      type: eventType,
      identity: d.event.identity,
      phase: d.phase,
      timestamp: d.event.timestamp || payload.timestamp,
      summary: summarizeAgentEvent(d.event),
    };
    this.appendLog(d.issueIid, entry);
  }

  private handlePipelineProgress(payload: EventPayload): void {
    const d = payload.data as { issueIid?: number; step?: string; message?: string };
    if (!d?.issueIid) return;

    const entry: AgentLogEntry = {
      type: 'system',
      phase: d.step,
      timestamp: payload.timestamp,
      summary: d.message || '',
    };
    this.appendLog(d.issueIid, entry);
  }
}
