import { beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let previous: string | undefined;
let directory: string;
/** 每个测试独立运行目录，避免计划产物写入开发者的真实工作台数据。 */
beforeEach(() => {
  previous = process.env.DATA_DIR;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iaf-test-data-'));
  process.env.DATA_DIR = directory;
});
afterEach(() => {
  if (previous === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
