import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { spawnProcess } from '../../src/utils/process.js';
import { TaskGraphExecutor } from '../../src/dag/TaskGraphExecutor.js';
import { graphFixture, graphDeps, task, newTracker, git } from '../helpers/dag-repository.js';

const root = path.resolve('.iaf-mini/test-dag-crash');
let output: string;
beforeAll(async () => {
  fs.mkdirSync(root, { recursive: true });
  output = path.join(fs.mkdtempSync(path.join(root, 'worker-')), 'crash-worker.mjs');
  await build({ entryPoints: ['tests/helpers/dag-crash-worker.ts'], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
});
afterAll(() => { fs.rmSync(path.dirname(output), { recursive: true, force: true }); });
describe('独立进程强制中断恢复', () => {
  it.each(['before-rebase', 'after-rebase-before-save', 'after-merge-before-save', 'during-rebase', 'pause-saved'])('%s 强杀进程后不重复调用或合并', async stage => {
    const fixture = graphFixture(stage === 'during-rebase' ? [task('a'), task('b')] : [task('a')]);
    const marker = path.join(fixture.directory, 'checkpoint');
    const child = spawnProcess(process.execPath, [output, JSON.stringify({ ...fixture, tracker: undefined, stage, marker })], { cwd: process.cwd() });
    let diagnostic = '';
    child.nodeChildProcess.stdout?.resume();
    child.nodeChildProcess.stderr?.on('data', data => { diagnostic += String(data); });
    try {
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(marker) && Date.now() < deadline && child.nodeChildProcess.exitCode === null) await new Promise(resolve => setTimeout(resolve, 50));
      expect(fs.existsSync(marker), diagnostic).toBe(true);
      child.nodeChildProcess.kill('SIGKILL');
      await child;
      fixture.tracker = newTracker(fixture.data);
      if (stage === 'pause-saved') { fixture.tracker.recoverInterruptedIssues(); expect(fixture.tracker.getDrivableIssues(3)).toEqual([]); expect(fixture.tracker.get(1)!.run!.stopIntent?.kind).toBe('pause'); return; }
      fixture.tracker.transaction(1, record => { record.run!.dispatchId = 'after-hard-crash'; });
      await new TaskGraphExecutor(graphDeps(fixture, { async run(options) { if (stage !== 'during-rebase' || !options.prompt.includes('只修复当前 rebase')) throw new Error('不应重新执行任务'); fs.writeFileSync(path.join(options.workDir, 'README.md'), '合并 a 和 b'); git(options.workDir, 'add', 'README.md'); return { success: true, output: '冲突已修复', exitCode: 0 }; }, killAll() {}, killByWorkDir() { return 0; } })).execute();
      expect(fs.readFileSync(path.join(fixture.directory, 'ai-calls.txt'), 'utf8').trim().split('\n')).toHaveLength(stage === 'during-rebase' ? 2 : 1);
      expect(fixture.tracker.get(1)!.run!.tasks.a.status).toBe('merged');
      expect(git(fixture.integration, 'rev-list', '--count', 'main..HEAD')).toBe(stage === 'during-rebase' ? '2' : '1');
    } finally {
      if (child.nodeChildProcess.exitCode === null) child.kill();
      await child;
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  }, 30000);
});
