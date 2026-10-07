import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { graphFixture, git } from '../helpers/dag-repository.js';
import { GitOperations } from '../../src/git/GitOperations.js';
import { runVerificationCommands } from '../../src/verify/VerificationCommands.js';

describe('Verify 命令执行与源码边界（真实 Git 和 Node 进程）', () => {
  let fixture: ReturnType<typeof graphFixture>;
  beforeEach(() => {
    fixture = graphFixture();
    fs.writeFileSync(path.join(fixture.integration, '.gitignore'), 'node_modules/\ndist/\n');
    fs.writeFileSync(path.join(fixture.integration, 'verify.cjs'), `
const fs = require('node:fs');
const command = process.argv[2];
if (command === 'cache') {
  fs.mkdirSync('node_modules/.vite-temp', { recursive: true });
  fs.writeFileSync('node_modules/.vite-temp/config.mjs', '缓存');
  fs.mkdirSync('dist', { recursive: true });
  fs.writeFileSync('dist/index.js', '构建结果');
  console.log('构建完成');
}
if (command === 'mutate') fs.writeFileSync('README.md', '被验证命令改写');
if (command === 'new-source') fs.writeFileSync('new-source.ts', '新源码');
if (command === 'fail') { console.error('真实断言失败'); process.exit(1); }
`);
    git(fixture.integration, 'add', '.');
    git(fixture.integration, 'commit', '-m', '验证配置');
  });
  afterEach(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));

  function run(test = 'cache') {
    return runVerificationCommands({
      workDir: fixture.integration,
      git: new GitOperations(fixture.integration),
      commands: {
        lint: 'node verify.cjs cache', build: 'node verify.cjs cache', test: `node verify.cjs ${test}`,
      },
      timeoutMs: 10_000,
    });
  }

  it('允许 Vite 缓存和构建产物写入，源码保持不变', async () => {
    const result = await run();
    expect(Object.values(result).map(check => check.exitCode)).toEqual([0, 0, 0]);
    expect(fs.existsSync(path.join(fixture.integration, 'node_modules/.vite-temp/config.mjs'))).toBe(true);
    expect(fs.readFileSync(path.join(fixture.integration, 'README.md'), 'utf8')).toBe('起点\n');
    expect(git(fixture.integration, 'status', '--porcelain')).toBe('');
  });

  it('每轮重新执行，不会沿用上次通过结果', async () => {
    expect((await run()).test.status).toBe('passed');
    const result = await run('fail');
    expect(result.test).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(result.test.diagnostics.join('\n')).toContain('真实断言失败');
  });

  it.each(['mutate', 'new-source'])('验证命令 %s 改动待交付内容时拒绝继续', async command => {
    await expect(run(command)).rejects.toThrow('验证命令修改了仓库');
  });

  it('即使源码内容未变，修改暂存区也会被识别', async () => {
    fs.writeFileSync(path.join(fixture.integration, 'README.md'), '待提交内容');
    await expect(runVerificationCommands({
      workDir: fixture.integration,
      git: new GitOperations(fixture.integration),
      commands: { lint: 'git add README.md', build: 'node verify.cjs cache', test: 'node verify.cjs cache' },
      timeoutMs: 10_000,
    })).rejects.toThrow('验证命令修改了仓库');
  });

  it('缺少项目清单时拒绝 npm 向父目录寻找脚本', async () => {
    const result = await runVerificationCommands({
      workDir: fixture.integration,
      git: new GitOperations(fixture.integration),
      commands: { lint: 'npm run lint', build: 'npm run build', test: 'npm test' },
      timeoutMs: 10_000,
    });
    expect(Object.values(result).map(check => check.exitCode)).toEqual([null, null, null]);
    expect(result.test.diagnostics.join('\n')).toContain('拒绝向父目录查找');
  });
});
