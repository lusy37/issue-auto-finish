import { extractTodolist } from '../persistence/TodolistExtractor.js';

/**
 * 解析验证阶段生成的报告，提取通过/失败状态和失败原因。
 *
 * 解析逻辑基于验证 prompt 要求 AI 输出的结构化格式，
 * 同时兼容中英文和多种常见写法。
 */

export interface TodolistStats {
  completed: number;
  total: number;
}

export interface VerifyReportResult {
  /** 综合判定：所有检查项均通过 */
  passed: boolean;
  lintPassed: boolean;
  buildPassed: boolean;
  testPassed: boolean;
  todolistComplete: boolean;
  todolistStats?: TodolistStats;
  /** 未通过的检查项及其原因 */
  failureReasons: string[];
  /** 原始报告内容 */
  rawReport: string;
}

// -- 匹配模式 --

// "Lint 结果: 失败" / "**Lint 结果**: 失败" / "Lint Result: Failed"
const LINT_FAIL_RE = /\*{0,2}Lint\s*(?:结果|Result)\*{0,2}\s*[:：]\s*(?:失败|failed|fail|未通过)/i;
const BUILD_FAIL_RE = /\*{0,2}Build\s*(?:结果|Result)\*{0,2}\s*[:：]\s*(?:失败|failed|fail|未通过)/i;
const TEST_FAIL_RE = /\*{0,2}Test\s*(?:结果|Result)\*{0,2}\s*[:：]\s*(?:失败|failed|fail|未通过)/i;

// "总结: 验证失败" / "**总结**: 验证失败" / "Summary: Verification Failed"
const SUMMARY_FAIL_RE = /\*{0,2}(?:总结|Summary)\*{0,2}\s*[:：].*(?:验证失败|verification\s+failed|failed|失败)/i;

// "Todolist 检查: 3/5 项完成" 或 "**Todolist 检查**: 3/5" 或 "Todolist: 3/5"
const TODOLIST_STATS_RE = /\*{0,2}(?:Todolist|Todo)\s*(?:检查|check)?\*{0,2}\s*[:：]\s*(\d+)\s*[/／]\s*(\d+)/i;

export class VerifyReportParser {
  /**
   * 解析验证报告内容。
   *
   * @param reportContent 验证报告的完整 Markdown 文本
   */
  parse(reportContent: string): VerifyReportResult {
    const lintPassed = !LINT_FAIL_RE.test(reportContent);
    const buildPassed = !BUILD_FAIL_RE.test(reportContent);
    const testPassed = !TEST_FAIL_RE.test(reportContent);

    const todolistStats = this.parseTodolistStats(reportContent);
    const todolistComplete = todolistStats
      ? todolistStats.total === 0 || todolistStats.completed === todolistStats.total
      : true; // 无统计数据时默认视为完成（不误判）

    const failureReasons: string[] = [];
    if (!lintPassed) failureReasons.push('Lint 检查失败');
    if (!buildPassed) failureReasons.push('Build 编译失败');
    if (!testPassed) failureReasons.push('测试未通过');
    if (!todolistComplete) {
      const statsText = todolistStats
        ? `(${todolistStats.completed}/${todolistStats.total})`
        : '';
      failureReasons.push(`Todolist 未全部完成${statsText}`);
    }

    // 如果上面各项都看似通过，但总结中明确写了"验证失败"，依然判为失败
    const summaryFailed = SUMMARY_FAIL_RE.test(reportContent);
    if (failureReasons.length === 0 && summaryFailed) {
      failureReasons.push('验证报告总结判定为失败');
    }

    const passed = failureReasons.length === 0;

    return {
      passed,
      lintPassed,
      buildPassed,
      testPassed,
      todolistComplete,
      todolistStats: todolistStats ?? undefined,
      failureReasons,
      rawReport: reportContent,
    };
  }

  /**
   * 从 plan 文件中解析 Todolist 完成度。
   * 与计划产物契约共用解析器，支持连字符、星号及嵌套待办。
   */
  parseTodolistFromPlan(planContent: string): TodolistStats {
    const { completed, total } = extractTodolist(planContent);
    return { completed, total };
  }

  /**
   * 从报告中提取 Todolist 统计数据。
   * 格式: "Todolist 检查: X/Y 项完成"
   */
  private parseTodolistStats(reportContent: string): TodolistStats | null {
    const match = reportContent.match(TODOLIST_STATS_RE);
    if (match) {
      return {
        completed: parseInt(match[1], 10),
        total: parseInt(match[2], 10),
      };
    }
    return null;
  }
}
