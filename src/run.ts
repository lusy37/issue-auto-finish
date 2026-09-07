import { main } from './index.js';
import { logger as rootLogger } from './logger.js';

const logger = rootLogger.child('Process');

// 顶层守护：定时器/事件回调里的同步异常或未处理的 Promise 抛出，
// 都会触发这两个钩子。EDQUOT/ENOSPC 等瞬态 IO 错误不应该让 守护进程 反复重启进程。
process.on('uncaughtException', (err: Error) => {
  const e = err as NodeJS.ErrnoException;
  logger.error('uncaughtException — keeping process alive', {
    message: err.message,
    code: e.code,
    errno: e.errno,
    syscall: e.syscall,
    path: e.path,
    stack: err.stack,
  });
});

process.on('unhandledRejection', (reason: unknown) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  const e = err as NodeJS.ErrnoException;
  logger.error('unhandledRejection — keeping process alive', {
    message: err.message,
    code: e.code,
    errno: e.errno,
    syscall: e.syscall,
    stack: err.stack,
  });
});

main().catch((err) => {
  // 启动失败时仍应 fail-fast 让 守护进程 知道初始化出问题
  console.error('Fatal error', (err as Error).message, (err as Error).stack);
  process.exit(1);
});
