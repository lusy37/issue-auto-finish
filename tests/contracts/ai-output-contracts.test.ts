/**
 * 契约测试 — AI 输出格式 × 解析逻辑
 *
 * 将项目对 AI 输出格式的隐式依赖显式化：
 *   1. Plan 产物格式 → TodolistExtractor 可消费
 *   2. Verify 报告格式 → 可提取待修复项
 *
 * 样本来源：tests/fixtures/ai-outputs/ 目录。
 * 新增 AI Runner 或 prompt 改动时应更新样本并重新验证。
 *
 * 注：PTY 帧识别契约已随 PTY 模式废弃一并移除。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTodolist, renderTodolistMarkdown, todolistProgressText } from '../../src/persistence/TodolistExtractor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'ai-outputs');

function loadFixture(relativePath: string): string {
  return fs.readFileSync(path.join(FIXTURES, relativePath), 'utf-8');
}

function loadAllInDir(dir: string): Array<{ name: string; content: string }> {
  const absDir = path.join(FIXTURES, dir);
  return fs.readdirSync(absDir)
    .filter(f => !f.endsWith('.ts'))
    .map(f => ({ name: f, content: fs.readFileSync(path.join(absDir, f), 'utf-8') }));
}


describe('AI 输出格式契约', () => {

  // ── Plan 产物契约 ──

  describe('Plan 产物格式', () => {
    const planFiles = loadAllInDir('plan');

    it('fixtures 目录包含至少 3 个 plan 样本', () => {
      expect(planFiles.length).toBeGreaterThanOrEqual(3);
    });

    describe.each(
      planFiles.filter(f => !f.name.includes('no-todos')),
    )('$name — 包含 todolist', ({ content }) => {
      it('TodolistExtractor 能提取至少 1 个 todo 项', () => {
        const summary = extractTodolist(content);
        expect(summary.total).toBeGreaterThan(0);
      });

      it('renderTodolistMarkdown 能将提取结果还原', () => {
        const summary = extractTodolist(content);
        const rendered = renderTodolistMarkdown(summary);
        expect(rendered).toContain('- [');
      });

      it('todolistProgressText 能生成进度文本', () => {
        const summary = extractTodolist(content);
        const text = todolistProgressText(summary);
        expect(text).toMatch(/\d+\/\d+ 完成 \(\d+%\)/);
      });
    });

    describe('01-plan-standard.md — Tasks 章节', () => {
      it('应包含 ## Tasks 章节', () => {
        const content = loadFixture('plan/01-plan-standard.md');
        expect(content).toMatch(/^## Tasks/m);
      });
    });

    describe('01-plan-chinese-headers.md — 中文章节', () => {
      it('应包含 ## 任务 章节', () => {
        const content = loadFixture('plan/01-plan-chinese-headers.md');
        expect(content).toMatch(/^## 任务/m);
      });
    });

    describe('01-plan-nested-todos.md — 嵌套 todolist', () => {
      it('应正确提取多层嵌套 todo', () => {
        const content = loadFixture('plan/01-plan-nested-todos.md');
        const summary = extractTodolist(content);
        const nested = summary.items.filter(i => i.depth > 0);
        expect(nested.length).toBeGreaterThan(0);
      });

      it('应正确统计已完成项', () => {
        const content = loadFixture('plan/01-plan-nested-todos.md');
        const summary = extractTodolist(content);
        expect(summary.completed).toBeGreaterThan(0);
        expect(summary.pending).toBeGreaterThan(0);
      });
    });

    describe('01-plan-no-todos.md — 无 todolist', () => {
      it('TodolistExtractor 返回空列表', () => {
        const content = loadFixture('plan/01-plan-no-todos.md');
        const summary = extractTodolist(content);
        expect(summary.total).toBe(0);
      });

      it('todolistProgressText 返回"无 Todolist 项"', () => {
        const content = loadFixture('plan/01-plan-no-todos.md');
        const summary = extractTodolist(content);
        expect(todolistProgressText(summary)).toBe('无 Todolist 项');
      });
    });
  });

  // ── Verify 报告契约 ──

  describe('Verify 报告格式', () => {
    it('通过的 verify 报告不应包含待修复 todolist', () => {
      const content = loadFixture('verify/02-verify-report-pass.md');
      const summary = extractTodolist(content);
      expect(summary.pending).toBe(0);
    });

    it('失败的 verify 报告应包含待修复项', () => {
      const content = loadFixture('verify/02-verify-report-fail.md');
      const summary = extractTodolist(content);
      expect(summary.pending).toBeGreaterThan(0);
    });
  });

});
