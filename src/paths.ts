import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
/** 使用独立数据目录。 */
export function getGlobalDir(): string {
  return path.resolve(
    process.env.IAF_MINI_HOME || path.join(projectRoot, ".iaf-mini", "github"),
  );
}
export function resolveDataDir(): string {
  return path.resolve(
    process.env.DATA_DIR || path.join(getGlobalDir(), "data"),
  );
}
export function resolveLogsDir(): string {
  return path.resolve(
    process.env.LOGS_DIR || path.join(getGlobalDir(), "logs"),
  );
}
export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
