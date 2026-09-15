import { main } from './index.js';
import { logger as rootLogger } from './logger.js';

const logger = rootLogger.child('Process');

// 进程级异常兜底：记录当前进程中未捕获的同步异常和未处理的 Promise rejection。
// 当前策略是不立即退出进程，以避免单个异常导致守护进程重启；
// 但异常可能使进程状态不再可靠。
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
