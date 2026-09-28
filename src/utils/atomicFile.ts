import fs from 'node:fs';
import { writeFileSync } from 'atomically';

/** 同步持久化 JSON，成功落盘后调用方才推进状态；重试和原子替换由库完成。 */
export function writeJsonAtomicSync(destination: string, data: unknown): void {
  const content = JSON.stringify(data, null, 2);
  if (content === undefined) throw new TypeError('无法保存未定义的 JSON 数据');
  writeTextAtomicSync(destination, content);
}

/** 文本与 JSON 共用同一套原子替换、失败清理和重试规则。 */
export function writeTextAtomicSync(destination: string, content: string): void {
  let temporary: string | undefined;
  try {
    writeFileSync(destination, content, {
      encoding: 'utf8',
      timeout: 350,
      tmpCreated: (file) => {
        temporary = file;
      },
    });
  } catch (error) {
    // 库的失败清理可能异步完成；保持返回前尝试清理、且不覆盖原始异常的约定。
    if (temporary) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        /* 仍被占用时由后续启动清理 */
      }
    }
    throw error;
  }
}
