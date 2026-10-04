import fs from 'node:fs';
import { chromium } from '@playwright/test';

export function resolveTestBrowserChannel(): string | undefined {
  const configured = process.env.IAF_TEST_BROWSER_CHANNEL?.trim();
  if (configured) return configured;
  if (process.platform === 'win32') return 'msedge';
  if (fs.existsSync(chromium.executablePath())) return undefined;
  throw new Error(
    '缺少 Playwright Chromium，请先运行 npm run e2e:install，或设置 IAF_TEST_BROWSER_CHANNEL',
  );
}
