import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { IssueCheckpointer, workflowThreadId } from '../../src/orchestrator/IssueCheckpointer.js';
import { newTracker } from '../helpers/dag-repository.js';

let directory: string;

beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-serialization-')); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

function createCheckpointer() {
  const tracker = newTracker(directory);
  tracker.create({
    lifecycle: { kind: 'pending' },
    branchName: 'iaf-1',
    demandSpec: {
      demandId: 'gh-1',
      sourceRef: { source: 'github-issue', externalId: '1', displayId: '1' },
      title: '检查点测试',
      description: '验证检查点序列化',
      createdAt: new Date().toISOString(),
    },
  });
  const threadId = workflowThreadId(1, 0, 0);
  return {
    tracker,
    checkpointer: new IssueCheckpointer(tracker.store, 1, threadId),
    config: { configurable: { thread_id: threadId } },
  };
}

describe('检查点 JSON 序列化', () => {
  it('保存 UTF-8 JSON 并可恢复原始检查点', async () => {
    const { tracker, checkpointer, config } = createCheckpointer();
    const checkpoint = emptyCheckpoint();
    checkpoint.channel_values = { entry: 'plan', result: { phase: 'plan' } };
    const metadata = { source: 'input' as const, step: 0, parents: {} };

    const savedConfig = await checkpointer.put(config, checkpoint, metadata);
    const stored = tracker.get(1)!.run!.workflow.checkpoints[0];

    expect(stored.checkpoint.type).toBe('json');
    expect(() => JSON.parse(stored.checkpoint.data)).not.toThrow();
    expect(JSON.parse(stored.checkpoint.data)).toEqual(checkpoint);
    expect(JSON.parse(stored.metadata.data)).toEqual(metadata);

    const restored = await checkpointer.getTuple(savedConfig);
    expect(restored?.checkpoint).toEqual(checkpoint);
    expect(restored?.metadata).toEqual(metadata);
  });

  it('拒绝顶层二进制写入，避免隐式回退到 Base64', async () => {
    const { tracker, checkpointer, config } = createCheckpointer();
    const savedConfig = await checkpointer.put(config, emptyCheckpoint(), { source: 'input', step: 0, parents: {} });

    await expect(checkpointer.putWrites(savedConfig, [['entry', new Uint8Array([1, 2, 3])]], 'task-1'))
      .rejects.toThrow('工作流检查点不支持序列化类型：bytes');
    expect(tracker.get(1)!.run!.workflow.writes).toHaveLength(0);
  });
});
