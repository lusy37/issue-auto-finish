import { describe, it, expect } from 'vitest';
import { VerifyReportParser } from '../../src/verify/VerifyReportParser.js';

describe('VerifyReportParser', () => {
  const parser = new VerifyReportParser();

  describe('parse()', () => {
    it('should detect all-pass report', () => {
      const report = `# 验证报告

- **Lint 结果**: 通过
- **Build 结果**: 通过
- **Test 结果**: 通过
- **Todolist 检查**: 5/5 项完成
- **总结**: 验证通过`;

      const result = parser.parse(report);
      expect(result.passed).toBe(true);
      expect(result.lintPassed).toBe(true);
      expect(result.buildPassed).toBe(true);
      expect(result.testPassed).toBe(true);
      expect(result.todolistComplete).toBe(true);
      expect(result.todolistStats).toEqual({ completed: 5, total: 5 });
      expect(result.failureReasons).toEqual([]);
    });

    it('should detect lint failure', () => {
      const report = `- **Lint 结果**: 失败
- 发现 3 个 ESLint 错误
- **Build 结果**: 通过
- **Test 结果**: 通过
- **总结**: 验证失败`;

      const result = parser.parse(report);
      expect(result.passed).toBe(false);
      expect(result.lintPassed).toBe(false);
      expect(result.buildPassed).toBe(true);
      expect(result.testPassed).toBe(true);
      expect(result.failureReasons).toContain('Lint 检查失败');
    });

    it('should detect build failure', () => {
      const report = `- **Lint 结果**: 通过
- **Build 结果**: 失败
TS2345: Argument of type 'string' is not assignable
- **Test 结果**: 通过
- **总结**: 验证失败`;

      const result = parser.parse(report);
      expect(result.passed).toBe(false);
      expect(result.buildPassed).toBe(false);
      expect(result.failureReasons).toContain('Build 编译失败');
    });

    it('should detect test failure', () => {
      const report = `- **Lint 结果**: 通过
- **Build 结果**: 通过
- **Test 结果**: 失败
2 tests failed out of 50
- **总结**: 验证失败`;

      const result = parser.parse(report);
      expect(result.passed).toBe(false);
      expect(result.testPassed).toBe(false);
      expect(result.failureReasons).toContain('测试未通过');
    });

    it('should detect incomplete todolist via stats', () => {
      const report = `- **Lint 结果**: 通过
- **Build 结果**: 通过
- **Test 结果**: 通过
- **Todolist 检查**: 3/5 项完成
  - [ ] 新增单元测试
  - [ ] 更新文档
- **总结**: 验证失败`;

      const result = parser.parse(report);
      expect(result.passed).toBe(false);
      expect(result.todolistComplete).toBe(false);
      expect(result.todolistStats).toEqual({ completed: 3, total: 5 });
      expect(result.failureReasons).toContain('Todolist 未全部完成(3/5)');
    });

    it('should detect multiple failures', () => {
      const report = `- **Lint 结果**: 失败
- **Build 结果**: 失败
- **Test 结果**: 失败
- **Todolist 检查**: 1/4 项完成
- **总结**: 验证失败`;

      const result = parser.parse(report);
      expect(result.passed).toBe(false);
      expect(result.failureReasons).toHaveLength(4);
      expect(result.failureReasons).toContain('Lint 检查失败');
      expect(result.failureReasons).toContain('Build 编译失败');
      expect(result.failureReasons).toContain('测试未通过');
      expect(result.failureReasons).toContain('Todolist 未全部完成(1/4)');
    });

    it('should handle English format', () => {
      const report = `- **Lint Result**: Failed
- **Build Result**: Pass
- **Test Result**: Pass
- **Summary**: Verification Failed`;

      const result = parser.parse(report);
      expect(result.passed).toBe(false);
      expect(result.lintPassed).toBe(false);
      expect(result.buildPassed).toBe(true);
      expect(result.testPassed).toBe(true);
    });

    it('should detect failure from summary when individual checks look ok', () => {
      const report = `- **Lint 结果**: 通过
- **Build 结果**: 通过
- **Test 结果**: 通过
- **总结**: 验证失败，代码不符合实施计划`;

      const result = parser.parse(report);
      expect(result.passed).toBe(false);
      expect(result.failureReasons).toContain('验证报告总结判定为失败');
    });

    it('should pass when todolist stats show 0/0', () => {
      const report = `- **Lint 结果**: 通过
- **Build 结果**: 通过
- **Test 结果**: 通过
- **Todolist 检查**: 0/0 项完成
- **总结**: 验证通过`;

      const result = parser.parse(report);
      expect(result.passed).toBe(true);
      expect(result.todolistComplete).toBe(true);
    });

    it('should preserve raw report content', () => {
      const report = 'Some report content';
      const result = parser.parse(report);
      expect(result.rawReport).toBe(report);
    });

    it('should handle empty report gracefully', () => {
      const result = parser.parse('');
      expect(result.passed).toBe(true);
      expect(result.lintPassed).toBe(true);
      expect(result.buildPassed).toBe(true);
      expect(result.testPassed).toBe(true);
      expect(result.failureReasons).toEqual([]);
    });

    it('should handle report without explicit result markers', () => {
      const report = `# 验证报告
所有检查通过，代码质量良好。`;

      const result = parser.parse(report);
      expect(result.passed).toBe(true);
    });
  });

  describe('parseTodolistFromPlan()', () => {
    it('should count completed and uncompleted items', () => {
      const plan = `# 实施计划

## Todolist
- [x] 步骤1: 创建数据模型
- [x] 步骤2: 实现 API 接口
- [ ] 步骤3: 新增单元测试
- [ ] 步骤4: 更新文档
- [x] 步骤5: 集成测试`;

      const stats = parser.parseTodolistFromPlan(plan);
      expect(stats.completed).toBe(3);
      expect(stats.total).toBe(5);
    });

    it('should handle all completed', () => {
      const plan = `- [x] Task 1
- [x] Task 2
- [x] Task 3`;

      const stats = parser.parseTodolistFromPlan(plan);
      expect(stats.completed).toBe(3);
      expect(stats.total).toBe(3);
    });

    it('should handle none completed', () => {
      const plan = `- [ ] Task 1
- [ ] Task 2`;

      const stats = parser.parseTodolistFromPlan(plan);
      expect(stats.completed).toBe(0);
      expect(stats.total).toBe(2);
    });

    it('should handle no todolist items', () => {
      const plan = `# 实施计划
Some text without checkboxes.`;

      const stats = parser.parseTodolistFromPlan(plan);
      expect(stats.completed).toBe(0);
      expect(stats.total).toBe(0);
    });

    it('should handle indented todolist items', () => {
      const plan = `  - [x] Indented completed
    - [ ] Deeply indented incomplete`;

      const stats = parser.parseTodolistFromPlan(plan);
      expect(stats.completed).toBe(1);
      expect(stats.total).toBe(2);
    });

    it('should be case-insensitive for [X] vs [x]', () => {
      const plan = `- [X] Task with uppercase X
- [x] Task with lowercase x
- [ ] Incomplete task`;

      const stats = parser.parseTodolistFromPlan(plan);
      expect(stats.completed).toBe(2);
      expect(stats.total).toBe(3);
    });
  });
});
