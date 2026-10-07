import {describe,it,expect} from 'vitest';
import path from 'node:path';
import {envSchema,transformEnvToConfig} from '../../../src/config-schema.js';
import { uatPolicySchema } from '../../../src/e2e/UatSchemas.js';
const required={GITHUB_API_URL:'https://platform.example.test',GITHUB_TOKEN:'test-token',GITHUB_REPOSITORY:'demo/project',PROJECT_WORK_DIR:'C:/demo/repo',WEB_BASE_URL:'http://127.0.0.1:3000'};
describe('裁剪版配置',()=>{
 it('图片数量默认不限，环境配置和运行策略均支持 0 及超过旧上限的正整数', () => {
   expect(envSchema.parse(required).E2E_VISUAL_REVIEW_MAX_IMAGES).toBe(0);
   for (const maxImages of [0, 6, 12, 15]) {
     expect(envSchema.parse({...required, E2E_VISUAL_REVIEW_MAX_IMAGES: String(maxImages)}).E2E_VISUAL_REVIEW_MAX_IMAGES).toBe(maxImages);
     expect(uatPolicySchema.parse({ visualReviewEnabled: true, maxImages, timeoutMs: 1000 }).maxImages).toBe(maxImages);
   }
   for (const value of ['-1', '1.5', 'invalid']) {
     expect(() => envSchema.parse({...required, E2E_VISUAL_REVIEW_MAX_IMAGES: value})).toThrow();
   }
 });
 it('只有公开执行器及当前模块',()=>{const config=transformEnvToConfig(envSchema.parse(required),path.resolve('fixture'));const stable=JSON.parse(JSON.stringify(config).replaceAll('\\','/'));stable.project.worktreeBaseDir='<mini>/worktrees';stable.web.frontendDistDir='<frontend>/dist';expect(stable).toMatchSnapshot();});
 it('拒绝已删除的执行器',()=>{expect(()=>envSchema.parse({...required,AI_RUNNER_MODE:'deleted-runner'})).toThrow();});
 it.each(['true', 'false'])('浏览器验收支持显式配置 %s', value => { expect(envSchema.parse({...required, E2E_UI_ENABLED: value}).E2E_UI_ENABLED).toBe(value === 'true'); });
 it.each(['', 'TRUE', '0', 'invalid'])('拒绝含糊的浏览器验收配置 %s', value => { expect(() => envSchema.parse({...required, E2E_UI_ENABLED: value})).toThrow(); });
 it('默认使用 Microsoft Edge，并支持覆盖 Playwright channel',()=>{expect(envSchema.parse(required).PLAYWRIGHT_CHANNEL).toBe('msedge');expect(envSchema.parse({...required,PLAYWRIGHT_CHANNEL:'chromium'}).PLAYWRIGHT_CHANNEL).toBe('chromium');});
 it('默认单任务并发，并保留中文及空格命令路径',()=>{const config=transformEnvToConfig(envSchema.parse({...required,CODEX_BINARY:'C:/中文 工具/codex.exe'}),path.resolve('fixture'));expect(config.poll.maxConcurrent).toBe(1);expect(config.ai.binary).toBe('C:/中文 工具/codex.exe');expect(config.project.gitRootDir).toBe(required.PROJECT_WORK_DIR);});
});
