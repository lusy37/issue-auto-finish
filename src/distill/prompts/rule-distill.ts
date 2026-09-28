/**
 * 规则蒸馏 prompt — Layer 3: 从成熟记忆中提取可执行的 Agent 规则。
 */
import type { MemoryEntry, AgentRuleEntry } from '../types.js';

export function buildRuleDistillPrompt(
  matureMemories: MemoryEntry[],
  existingRules: AgentRuleEntry[],
): string {
  const memorySection = matureMemories
    .map((m, i) => {
      return [
        `### 成熟记忆 ${i + 1} (ID: ${m.id})`,
        `- 主题: ${m.theme}`,
        `- 标题: ${m.title}`,
        `- 信心度: ${m.confidence}`,
        `- 证据数: ${m.evidence.length}`,
        `- 已提升为规则: ${m.promotedToRule ? '是' : '否'}`,
        '',
        m.content,
      ].join('\n');
    })
    .join('\n\n---\n\n');

  const ruleSection =
    existingRules.length > 0
      ? existingRules
          .map((r, i) => {
            return [
              `### 现有规则 ${i + 1} (ID: ${r.id})`,
              `- 规则名: ${r.ruleName}`,
              `- 标题: ${r.title}`,
              `- 关键词: ${r.keywords.join(', ')}`,
              `- 已废弃: ${r.deprecated ? '是' : '否'}`,
              '',
              r.content.slice(0, 300) + (r.content.length > 300 ? '...' : ''),
            ].join('\n');
          })
          .join('\n\n')
      : '（暂无现有规则）';

  return `你是 AI Agent 规范制定专家。请分析以下成熟的经验记忆，判断哪些可以升级为 Agent 开发规则。

## 成熟记忆

${memorySection}

## 现有规则

${ruleSection}

## 任务

1. 评估每条成熟记忆是否适合转化为 Agent 规则
2. 如果适合，生成 Markdown 规则内容
3. 如果现有规则需要更新（因为有新的记忆支持），输出更新操作
4. 如果现有规则已经过时（被新记忆推翻），输出废弃操作

## 规则内容格式

规则内容应该是可操作的指导，包含：
- 问题场景描述
- 具体的操作步骤或代码规范
- 必要时附带代码示例
- 使用中文

## 输出格式

请严格按以下 JSON 格式输出，不要添加任何其他文字：

\`\`\`json
{
  "actions": [
    {
      "type": "CREATE",
      "ruleName": "kebab-case-rule-name",
      "title": "规则标题",
      "content": "Markdown 规则的正文内容（Markdown 格式）",
      "keywords": ["触发关键词"],
      "alwaysApply": false,
      "sourceMemoryIds": ["来源 memory ID"]
    },
    {
      "type": "UPDATE",
      "ruleId": "已有 rule 的 ID",
      "content": "更新后的内容",
      "keywords": ["更新后的关键词，可选"]
    },
    {
      "type": "DEPRECATE",
      "ruleId": "需废弃的 rule ID",
      "reason": "废弃原因"
    }
  ]
}
\`\`\`

## 判断标准
- 只有具体、可操作的模式才适合转为规则
- 过于宽泛的建议（如"提高代码质量"）不适合作为规则
- alwaysApply 只对非常通用的规则设为 true
- ruleName 使用 kebab-case，简短有意义`;
}
