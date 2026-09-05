import { Command } from 'commander';
import { main } from '../index.js';
await new Command().name('issue-auto-finish').command('start').description('启动工作台').action(main).parseAsync();
