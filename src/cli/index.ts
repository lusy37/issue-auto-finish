import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { resolveConfigFilePath } from '../config.js';
import { findExecutable, runProcess } from '../utils/process.js';
const program = new Command().name('issue-auto-finish').description('单仓库 AI 开发工作台');
program.command('start').description('启动工作台').action(async () => { const {main} = await import('../index.js'); await main(); });
program.command('init').description('初始化独立配置').action(() => {
  const file = resolveConfigFilePath();
  if (fs.existsSync(file)) throw new Error('配置已存在，请直接编辑');
  fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.writeFileSync(file, 'GITHUB_REPOSITORY=owner/repo\nGITHUB_TOKEN=replace-me\nPROJECT_WORK_DIR=' + process.cwd().replaceAll('\\','/') + '\nBASE_BRANCH=main\n');
  console.log('配置已创建：'+file);
});
program.command('doctor').description('检查本机依赖').action(async () => {
  for(const name of ['node','git']) {
    const binary = findExecutable(name);
    if (!binary) { console.error(name + '：未安装'); process.exitCode=1; continue; }
    const result = await runProcess(binary,['--version'],{cwd:process.cwd(),timeoutMs:10000});
    console.log(name+': '+result.stdout.trim());
    if(result.code !== 0) process.exitCode=1;
  }
  console.log('配置：'+resolveConfigFilePath());
});
program.parseAsync().catch(error => {console.error(error.message);process.exitCode=1;});
