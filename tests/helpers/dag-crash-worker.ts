import fs from 'node:fs';
import path from 'node:path';
import { TaskGraphExecutor } from '../../src/dag/TaskGraphExecutor.js';
import { graphDeps, newTracker } from './dag-repository.js';

const input = JSON.parse(process.argv[2]) as { directory: string; repo: string; data: string; worktrees: string; integration: string; stage: string; marker: string };
const fixture = { ...input, tracker: newTracker(input.data) };
const executor = new TaskGraphExecutor(graphDeps(fixture, {
  async run(options) {
    fs.appendFileSync(path.join(input.directory, 'ai-calls.txt'), '调用\n');
    fs.writeFileSync(path.join(options.workDir, input.stage === 'during-rebase' ? 'README.md' : 'a.txt'), options.identity!.taskId);
    return { success: true, output: '完成', exitCode: 0 };
  },
  killAll() {}, killByWorkDir() { return 0; },
}, { checkpoint: async name => {
  if (input.stage === 'pause-saved' && name === 'execution-saved') {
    fixture.tracker.transaction(1, record => {
      record.run.stopIntent = { kind: 'pause', requestedAt: new Date().toISOString() };
      record.lifecycle = { kind: 'paused', phase: 'build' };
    });
  } else if (name !== input.stage) return;
  fs.writeFileSync(input.marker, name);
  // 测试父进程会强制终止这里，无法运行 catch/finally 或清理逻辑。
  await new Promise(() => setInterval(() => {}, 1000));
} }));
await executor.execute();
