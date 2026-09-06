import fs from "node:fs";
import path from "node:path";
/** 本机实例锁：原子创建，恢复已退出进程的残留锁。 */
export function acquireInstanceLock(dataDir: string): () => void {
  const file = path.join(dataDir, "instance.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          if (fs.readFileSync(file, "utf8") === String(process.pid))
            fs.unlinkSync(file);
        } catch {
          /* 已释放 */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = Number(fs.readFileSync(file, "utf8"));
      if (!Number.isInteger(pid) || pid <= 0)
        throw new Error(
          "实例锁格式错误，请确认旧进程已退出后清理 instance.lock",
        );
      try {
        process.kill(pid, 0);
        throw new Error("该数据目录已有运行中的实例");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
      fs.unlinkSync(file);
    }
  }
  throw new Error("无法取得实例锁");
}
