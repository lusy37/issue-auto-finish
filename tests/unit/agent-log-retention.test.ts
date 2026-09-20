import { it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { AgentLogStore, MAX_LOGS_PER_ISSUE, LOG_TRIM_BATCH_SIZE } from '../../src/web/AgentLogStore.js';
import { eventBus, type EventPayload } from '../../src/events/EventBus.js';

it('批量追加不逐条扫描，阈值裁剪后重启可读且单条受限', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '日志裁剪-'));
  const before = eventBus.listeners('agent:output');
  const progress = eventBus.listeners('pipeline:progress');
  const store = new AgentLogStore(directory);
  const file = path.join(directory, 'agent-logs/42.jsonl');
  const entry = JSON.stringify({ type: 'text', summary: '旧日志', timestamp: '2026-09-20' });
  fs.writeFileSync(file, (entry + '\n').repeat(MAX_LOGS_PER_ISSUE));
  store.startListening();
  const read = vi.spyOn(fs, 'readFileSync');
  const write = vi.spyOn(fs, 'writeFileSync');
  const started = performance.now();
  try {
    for (let i = 0; i < LOG_TRIM_BATCH_SIZE; i++) eventBus.emitTyped('pipeline:progress', { issueIid: 42, step: 'build', message: i === LOG_TRIM_BATCH_SIZE - 1 ? '新'.repeat(4000) : `日志 ${i}` });
    const reads = read.mock.calls.filter(([p]) => p === file).length;
    const rewrites = write.mock.calls.filter(([p, , options]) => p === file && options === 'utf-8').length;
    expect(reads).toBe(2);
    expect(rewrites).toBe(1);
    console.info(`日志样本：${LOG_TRIM_BATCH_SIZE} 次追加，读取 ${reads} 次，裁剪 ${rewrites} 次，${Math.round(performance.now() - started)}ms`);
    const restarted = new AgentLogStore(directory);
    const logs = restarted.getLogs(42);
    expect(logs).toHaveLength(MAX_LOGS_PER_ISSUE);
    expect(logs.at(-1)!.summary.length).toBeLessThanOrEqual(2000);
  } finally {
    read.mockRestore(); write.mockRestore();
    for (const listener of eventBus.listeners('agent:output')) if (!before.includes(listener)) eventBus.off('agent:output', listener as (payload: EventPayload) => void);
    for (const listener of eventBus.listeners('pipeline:progress')) if (!progress.includes(listener)) eventBus.off('pipeline:progress', listener as (payload: EventPayload) => void);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
