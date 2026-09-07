/**
 * 记忆蒸馏 prompt — Layer 2: 从日记批次中提取共性模式。
 */
import type { DiaryEntry, MemoryEntry } from '../types.js';

export function buildMemoryDistillPrompt(
  diaries: DiaryEntry[],
  existingMemories: MemoryEntry[],
): string {
  const diarySection = diaries.map((d, i) => {
    const lines = [
      `### 日记 ${i + 1} (ID: ${d.id})`,
      `- Issue: #${d.issueIid} — ${d.issueTitle}`,
      `- 结果: ${d.outcome}`,
      `- 流水线: ${d.pipelineMode}`,
      `- 总耗时: ${Math.round(d.timing.totalDurationMs / 1000 / 60)}分钟`,
    ];
    if (d.timing.phaseTimings.length > 0) {
      lines.push('- 各阶段耗时:');
      for (const pt of d.timing.phaseTimings) {
        lines.push(`  - ${pt.phase}: ${Math.round(pt.durationMs / 1000 / 60)}分钟`);
      }
    }
    if (d.failure) {
      lines.push(`- 失败阶段: ${d.failure.failedAtPhase}`);
      lines.push(`- 失败原因: ${d.failure.error}`);
      lines.push(`- 尝试次数: ${d.failure.attempts}`);
    }
    if (d.humanInterventions.length > 0) {
      lines.push('- 人工介入:');
      for (const h of d.humanInterventions) {
        lines.push(`  - ${h.type}: ${h.detail}`);
      }
    }
    if (d.artifactSummary) {
      lines.push(`- 产物摘要: ${d.artifactSummary}`);
    }
    return lines.join('\n');
  }).join('\n\n');

  const memorySection = existingMemories.length > 0
    ? existingMemories.map((m, i) => {
        return [
          `### 现有记忆 ${i + 1} (ID: ${m.id})`,
          `- 主题: ${m.theme}`,
          `- 标题: ${m.title}`,
          `- 信心度: ${m.confidence}`,
          `- 证据数: ${m.evidence.length}`,
          `- 内容摘要: ${m.content.slice(0, 200)}${m.content.length > 200 ? '...' : ''}`,
        ].join('\n');
      }).join('\n\n')
    : '（暂无现有记忆）';

  return `你是经验分析专家。请分析以下 Issue 执行日记，识别共性模式，并输出结构化的操作指令。

## 待分析的日记

${diarySection}

## 现有记忆库

${memorySection}

## 分析维度

请从以下五个维度分析日记：
1. **failure-pattern** — 失败模式与解法：哪些类型的错误频繁出现？是否有共同的根因？
2. **efficiency-insight** — 执行效率洞察：哪些阶段耗时异常？有哪些性能瓶颈？
3. **intervention-pattern** — 人工介入模式：什么情况下需要人工介入？能否自动化？
4. **optimization-suggestion** — 流程优化建议：结合业界最佳实践，有哪些改进方向？
5. **rejection-pattern** — 方案驳回模式：聚焦人工介入中 \`review-reject\` 类型的反馈。哪些类型的方案频繁被人工驳回？驳回原因是否有共性（如范围过大、缺少验证、风险评估不足、未考虑权限/边界/异常处理等）？应在生成方案时主动规避哪些反模式？

## 输出格式

请严格按以下 JSON 格式输出操作数组，不要添加任何其他文字：

\`\`\`json
{
  "actions": [
    {
      "type": "CREATE",
      "theme": "failure-pattern|efficiency-insight|intervention-pattern|optimization-suggestion|rejection-pattern",
      "title": "简短标题",
      "content": "Markdown 格式的详细描述，包括：现象、原因分析、建议解法",
      "diaryIds": ["关联的日记ID"]
    },
    {
      "type": "MERGE",
      "memoryId": "已有 memory 的 ID",
      "newEvidence": ["新增的日记ID"],
      "updatedContent": "如果内容需要更新，提供新内容（可选）"
    },
    {
      "type": "SUPERSEDE",
      "oldMemoryId": "被替代的旧 memory ID",
      "theme": "新主题分类",
      "title": "新标题",
      "content": "新的完整内容",
      "diaryIds": ["关联的日记ID"]
    }
  ]
}
\`\`\`

## 规则
- 如果新日记提供了新的证据支持已有记忆，使用 MERGE
- 如果新日记推翻了旧的认知，使用 SUPERSEDE
- 只有确实发现新模式时才使用 CREATE
- 每个 action 必须关联至少一个日记 ID
- confidence 由系统自动计算，无需在输出中提供`;
}
