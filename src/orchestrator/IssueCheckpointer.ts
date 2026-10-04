import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
} from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import { WRITES_IDX_MAP } from '@langchain/langgraph-checkpoint';
import type { IssueRunStore } from '../dag/IssueRunStore.js';
import type {
  SerializedValue,
  StoredCheckpoint,
  StoredWrite,
} from '../orchestration/WorkflowState.js';

type ListOptions = Parameters<BaseCheckpointSaver['list']>[1];
type PendingWrites = Parameters<BaseCheckpointSaver['putWrites']>[1];

/** 实现框架检查点协议，所有检查点与待提交写入均进入已有的每 Issue 聚合事务。 */
export class IssueCheckpointer extends BaseCheckpointSaver {
  constructor(
    private readonly store: IssueRunStore,
    private readonly number: number,
    readonly threadId: string,
  ) {
    super();
  }

  private assertThread(config: RunnableConfig): void {
    if (config.configurable?.thread_id !== this.threadId)
      throw new Error('检查点线程与 Issue 不匹配');
    const record = this.store.get(this.number);
    if (
      !record ||
      workflowThreadId(
        this.number,
        record.run.buildGeneration,
        record.run.workflow.generation,
      ) !== this.threadId
    )
      throw new Error('流程执行轮次已失效');
  }
  private async encode(value: unknown): Promise<SerializedValue> {
    const [type, data] = await this.serde.dumpsTyped(value);
    if (type !== 'json') throw new Error(`工作流检查点不支持序列化类型：${type}`);
    return { type, data: new TextDecoder().decode(data) };
  }
  private decode<T = unknown>(value: SerializedValue): Promise<T> {
    if (value.type !== 'json') throw new Error(`工作流检查点包含不支持的序列化类型：${value.type}`);
    return this.serde.loadsTyped(value.type, value.data) as Promise<T>;
  }
  private config(namespace: string, checkpointId: string): RunnableConfig {
    return {
      configurable: {
        thread_id: this.threadId,
        checkpoint_ns: namespace,
        checkpoint_id: checkpointId,
      },
    };
  }
  private async tuple(saved: StoredCheckpoint, writes: StoredWrite[]): Promise<CheckpointTuple> {
    return {
      config: this.config(saved.namespace, saved.id),
      checkpoint: await this.decode(saved.checkpoint),
      metadata: await this.decode(saved.metadata),
      parentConfig: saved.parentId ? this.config(saved.namespace, saved.parentId) : undefined,
      pendingWrites: await Promise.all(
        writes
          .filter(
            (w) =>
              w.threadId === saved.threadId &&
              w.namespace === saved.namespace &&
              w.checkpointId === saved.id,
          )
          .map(
            async (w) =>
              [w.taskId, w.channel, await this.decode(w.value)] as [string, string, unknown],
          ),
      ),
    };
  }
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.assertThread(config);
    const namespace = config.configurable?.checkpoint_ns ?? '';
    const id = config.configurable?.checkpoint_id;
    const storage = this.store.get(this.number)!.run.workflow;
    const saved = storage.checkpoints
      .filter(
        (c) => c.threadId === this.threadId && c.namespace === namespace && (!id || c.id === id),
      )
      .sort((a, b) => b.id.localeCompare(a.id))[0];
    return saved ? this.tuple(saved, storage.writes) : undefined;
  }
  async *list(config: RunnableConfig, options: ListOptions = {}): AsyncGenerator<CheckpointTuple> {
    this.assertThread(config);
    const storage = this.store.get(this.number)!.run.workflow;
    let remaining = options.limit ?? Infinity;
    for (const saved of storage.checkpoints
      .filter((c) => c.threadId === this.threadId)
      .sort((a, b) => b.id.localeCompare(a.id))) {
      if (remaining <= 0) break;
      if (
        config.configurable?.checkpoint_ns !== undefined &&
        saved.namespace !== config.configurable.checkpoint_ns
      )
        continue;
      if (config.configurable?.checkpoint_id && saved.id !== config.configurable.checkpoint_id)
        continue;
      if (
        options.before?.configurable?.checkpoint_id &&
        saved.id >= options.before.configurable.checkpoint_id
      )
        continue;
      const tuple = await this.tuple(saved, storage.writes);
      if (
        options.filter &&
        !Object.entries(options.filter).every(
          ([key, value]) =>
            JSON.stringify((tuple.metadata as Record<string, unknown>)[key]) ===
            JSON.stringify(value),
        )
      )
        continue;
      remaining--;
      yield tuple;
    }
  }
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    this.assertThread(config);
    const saved: StoredCheckpoint = {
      threadId: this.threadId,
      namespace: config.configurable?.checkpoint_ns ?? '',
      id: checkpoint.id,
      parentId: config.configurable?.checkpoint_id,
      checkpoint: await this.encode(checkpoint),
      metadata: await this.encode(metadata),
    };
    this.assertThread(config);
    this.store.transaction(this.number, (record) => {
      const checkpoints = record.run.workflow.checkpoints;
      const index = checkpoints.findIndex(
        (c) =>
          c.threadId === saved.threadId && c.namespace === saved.namespace && c.id === saved.id,
      );
      if (index < 0) checkpoints.push(saved);
      else checkpoints[index] = saved;
    });
    return this.config(saved.namespace, saved.id);
  }
  async putWrites(config: RunnableConfig, writes: PendingWrites, taskId: string): Promise<void> {
    this.assertThread(config);
    const checkpointId = config.configurable?.checkpoint_id;
    if (!checkpointId) throw new Error('节点写入缺少检查点 ID');
    const encoded = await Promise.all(
      writes.map(
        async ([channel, value], index): Promise<StoredWrite> => ({
          threadId: this.threadId,
          namespace: config.configurable?.checkpoint_ns ?? '',
          checkpointId,
          taskId,
          index: WRITES_IDX_MAP[channel] ?? index,
          channel,
          value: await this.encode(value),
        }),
      ),
    );
    this.assertThread(config);
    this.store.transaction(this.number, (record) => {
      const stored = record.run.workflow.writes;
      for (const write of encoded) {
        const index = stored.findIndex(
          (w) =>
            w.threadId === write.threadId &&
            w.namespace === write.namespace &&
            w.checkpointId === write.checkpointId &&
            w.taskId === write.taskId &&
            w.index === write.index,
        );
        if (index < 0) stored.push(write);
        else if (write.index < 0) stored[index] = write;
      }
    });
  }
  async deleteThread(threadId: string): Promise<void> {
    this.assertThread({ configurable: { thread_id: threadId } });
    this.store.transaction(this.number, (record) => {
      const storage = record.run.workflow;
      storage.checkpoints = storage.checkpoints.filter((c) => c.threadId !== threadId);
      storage.writes = storage.writes.filter((w) => w.threadId !== threadId);
      for (const operation of Object.keys(storage.results))
        if (operation.startsWith(threadId + ':')) delete storage.results[operation];
      storage.effects = storage.effects.filter(
        (operation) => !operation.startsWith(threadId + ':'),
      );
    });
  }
}

export function workflowThreadId(
  number: number,
  buildGeneration: number,
  generation: number,
): string {
  return `issue:${number}:build:${buildGeneration}:workflow:${generation}`;
}
