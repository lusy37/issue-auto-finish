import { CodexRunner } from './CodexRunner.js';
import type { RunOptions } from './AIRunner.js';

/** IPC 仅传工作台事件；Codex 协议始终由官方 SDK 处理。 */
let runner: CodexRunner | undefined;
let started = false;
process.on('disconnect', () => { runner?.killAll(); });
process.on('message', async (message: { options: RunOptions; binary: string; model?: string }) => {
  if (started) return;
  started = true;
  runner = new CodexRunner(message.binary, message.model);
  const send = (value: unknown) => { if (process.connected) process.send?.(value); };
  try {
    const result = await runner.run({ ...message.options, onStreamEvent: event => send({ type: 'event', event }) });
    send({ type: 'result', result });
  } catch (error) {
    send({ type: 'result', result: { success: false, output: '', exitCode: null, errorMessage: (error as Error).message } });
  } finally {
    // disconnect 等待 IPC 队列发送完毕；服务端仍等待该进程及后代退出。
    if (process.connected) process.disconnect?.();
  }
});
