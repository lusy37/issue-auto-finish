/** 只提取模型的最终 JSON 内容，业务结构由调用方的 Codec 校验。 */
export function parseJsonOutput(output: string): unknown {
  const text = output.trim();
  if (!text) throw new Error('模型输出为空');
  const blocks = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/gi)];
  if (blocks.length > 1) throw new Error('模型输出包含多个 JSON 代码块');
  return JSON.parse(blocks.length ? blocks[0][1].trim() : text);
}
