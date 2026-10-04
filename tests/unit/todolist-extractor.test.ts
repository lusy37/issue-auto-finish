import { describe, it, expect } from 'vitest';
import {
  extractTodolist,
  renderTodolistMarkdown,
  todolistProgressText,
} from '../helpers/todolist-extractor.js';

describe('TodolistExtractor', () => {
  describe('extractTodolist', () => {
    it('extracts unchecked items', () => {
      const md = '- [ ] Step 1\n- [ ] Step 2';
      const result = extractTodolist(md);
      expect(result.total).toBe(2);
      expect(result.completed).toBe(0);
      expect(result.pending).toBe(2);
      expect(result.items[0]).toMatchObject({ text: 'Step 1', completed: false, depth: 0 });
    });

    it('extracts checked items', () => {
      const md = '- [x] Done 1\n- [X] Done 2';
      const result = extractTodolist(md);
      expect(result.total).toBe(2);
      expect(result.completed).toBe(2);
      expect(result.pending).toBe(0);
    });

    it('handles mixed checked/unchecked items', () => {
      const md = `
# Plan

## Todolist
- [x] Step 1: Create module
- [ ] Step 2: Add tests
- [x] Step 3: Update docs
- [ ] Step 4: Deploy
`;
      const result = extractTodolist(md);
      expect(result.total).toBe(4);
      expect(result.completed).toBe(2);
      expect(result.pending).toBe(2);
    });

    it('detects nesting depth from indentation', () => {
      const md = `- [ ] Parent task
  - [ ] Sub-task 1
  - [x] Sub-task 2
    - [ ] Sub-sub-task`;
      const result = extractTodolist(md);
      expect(result.items).toHaveLength(4);
      expect(result.items[0].depth).toBe(0);
      expect(result.items[1].depth).toBe(1);
      expect(result.items[2].depth).toBe(1);
      expect(result.items[3].depth).toBe(2);
    });

    it('works with asterisk bullet points', () => {
      const md = '* [ ] Star item 1\n* [x] Star item 2';
      const result = extractTodolist(md);
      expect(result.total).toBe(2);
      expect(result.items[0].text).toBe('Star item 1');
    });

    it('returns empty summary for markdown without checkboxes', () => {
      const md = '# Just a heading\n\nSome text without any checkboxes.';
      const result = extractTodolist(md);
      expect(result.total).toBe(0);
      expect(result.items).toEqual([]);
    });

    it('preserves sequential index', () => {
      const md = '- [ ] A\n\nSome text\n\n- [x] B\n- [ ] C';
      const result = extractTodolist(md);
      expect(result.items[0].index).toBe(0);
      expect(result.items[1].index).toBe(1);
      expect(result.items[2].index).toBe(2);
    });

    it('handles real-world plan content', () => {
      const md = `# 实施计划

## 第一部分：需求分析
需求概述...

## 第二部分：系统设计
方案概述...

## 第三部分：实施 Todolist
- [ ] 步骤1: 创建 PlanFileResolver 模块
- [ ] 步骤2: 修改 PtyRunner.runNativePlanMode()
- [x] 步骤3: 添加 PlanPersistence.copyPlanFromExternal()
- [ ] 步骤4: 编写单元测试
- [x] 步骤5: 更新文档
`;
      const result = extractTodolist(md);
      expect(result.total).toBe(5);
      expect(result.completed).toBe(2);
      expect(result.pending).toBe(3);
      expect(result.items[0].text).toContain('PlanFileResolver');
    });
  });

  describe('renderTodolistMarkdown', () => {
    it('renders items back to markdown checkbox format', () => {
      const md = '- [ ] Task A\n- [x] Task B';
      const summary = extractTodolist(md);
      const rendered = renderTodolistMarkdown(summary);
      expect(rendered).toBe('- [ ] Task A\n- [x] Task B');
    });

    it('preserves indentation for nested items', () => {
      const md = '- [ ] Parent\n  - [x] Child';
      const summary = extractTodolist(md);
      const rendered = renderTodolistMarkdown(summary);
      expect(rendered).toBe('- [ ] Parent\n  - [x] Child');
    });
  });

  describe('todolistProgressText', () => {
    it('shows progress with percentage', () => {
      const md = '- [x] Done\n- [ ] Pending';
      const summary = extractTodolist(md);
      expect(todolistProgressText(summary)).toBe('1/2 完成 (50%)');
    });

    it('shows all complete', () => {
      const md = '- [x] Done 1\n- [x] Done 2';
      const summary = extractTodolist(md);
      expect(todolistProgressText(summary)).toBe('2/2 完成 (100%)');
    });

    it('shows message for empty todolist', () => {
      const summary = extractTodolist('no checkboxes here');
      expect(todolistProgressText(summary)).toBe('无 Todolist 项');
    });
  });
});
