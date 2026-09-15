import {describe,it,expect} from 'vitest';
import path from 'node:path';
import {envSchema,transformEnvToConfig} from '../../../src/config-schema.js';
const required={GITHUB_API_URL:'https://platform.example.test',GITHUB_TOKEN:'test-token',GITHUB_REPOSITORY:'demo/project',PROJECT_WORK_DIR:'C:/demo/repo',WEB_BASE_URL:'http://127.0.0.1:3000'};
describe('裁剪版配置',()=>{
 it('只有公开执行器及当前模块',()=>{const config=transformEnvToConfig(envSchema.parse(required),path.resolve('fixture'));const stable=JSON.parse(JSON.stringify(config).replaceAll('\\','/'));stable.project.worktreeBaseDir='<mini>/worktrees';stable.web.frontendDistDir='<frontend>/dist';expect(stable).toMatchSnapshot();});
 it('拒绝已删除的执行器',()=>{expect(()=>envSchema.parse({...required,AI_RUNNER_MODE:'deleted-runner'})).toThrow();});
 it.each(['true', 'false'])('浏览器验收支持显式配置 %s', value => { expect(envSchema.parse({...required, E2E_UI_ENABLED: value}).E2E_UI_ENABLED).toBe(value === 'true'); });
 it.each(['', 'TRUE', '0', 'invalid'])('拒绝含糊的浏览器验收配置 %s', value => { expect(() => envSchema.parse({...required, E2E_UI_ENABLED: value})).toThrow(); });
 it('默认单任务并发，并保留中文及空格命令路径',()=>{const config=transformEnvToConfig(envSchema.parse({...required,CODEX_BINARY:'C:/中文 工具/codex.exe'}),path.resolve('fixture'));expect(config.poll.maxConcurrent).toBe(1);expect(config.ai.binary).toBe('C:/中文 工具/codex.exe');expect(config.project.gitRootDir).toBe(required.PROJECT_WORK_DIR);});
});
