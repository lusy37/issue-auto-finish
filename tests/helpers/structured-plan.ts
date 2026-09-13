/** 报告解析测试仍可用 Markdown 夹具；计划阶段夹具显式包装为新的结构化协议。 */
export function structuredPlanOutput(description = '实现需求并覆盖验证与浏览器验收。'): string {
  return JSON.stringify({ title: '实施计划', description, acceptanceCriteria: ['需求完整实现，验证通过'], tasks: [{ id: 'implementation', title: '实现需求', instructions: description, acceptanceCriteria: ['代码及测试符合需求'], dependsOn: [] }] });
}
