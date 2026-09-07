import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { executeUat } from '../../src/e2e/PlaywrightRunner.js';

let project: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (project) fs.rmSync(project, { recursive: true, force: true, maxRetries: 3 });
});

it('目标项目独立安装 Playwright 时，配置和用例使用同一运行时', async () => {
  const base = path.resolve('.iaf-mini/uat-runtime-tests');
  fs.mkdirSync(base, { recursive: true });
  project = fs.mkdtempSync(path.join(base, '独立 仓库 '));
  const localRequire = createRequire(import.meta.url);
  // 复制真实包模拟独立 npm install；即使版本相同，不同副本也不能混用测试上下文。
  for (const name of ['playwright', '@playwright/test']) {
    const source = path.dirname(localRequire.resolve(name + '/package.json'));
    fs.cpSync(source, path.join(project, 'node_modules', name), { recursive: true });
  }
  fs.writeFileSync(path.join(project, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(project, 'playwright.config.ts'),
    "import {defineConfig} from '@playwright/test'; export default defineConfig({testDir:'.',testMatch:'runtime.spec.ts',workers:1});");
  fs.writeFileSync(path.join(project, 'runtime.spec.ts'),
    "import {test,expect} from '@playwright/test'; test('收到工作台验收地址',()=>{expect(process.env.UAT_BASE_URL).toBe('http://127.0.0.1:9876');});");
  vi.stubEnv('DATA_DIR', path.join(project, 'data'));
  const result = await executeUat({ issueIid: 1, workDir: project, configFile: 'playwright.config.ts', baseUrl: 'http://127.0.0.1:9876', timeoutMs: 20000 });
  expect(result.error).toBeUndefined();
  expect(result).toMatchObject({ passed: true, passedTests: 1, failedTests: 0 });
});
