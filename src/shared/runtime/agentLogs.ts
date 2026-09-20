/** 单条日志最多保留 2000 个字符；服务端留存量和页面窗口容量各自独立。 */
export const MAX_AGENT_SUMMARY_LENGTH = 2000;
export const clampAgentSummary = (text: string): string => text.length > MAX_AGENT_SUMMARY_LENGTH
  ? text.slice(0, MAX_AGENT_SUMMARY_LENGTH - 1) + '…' : text;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function summarizeAgentEvent(event: { type?: string; content?: unknown }): string {
  const content = event.content;
  if (content == null) return '';
  if (typeof content === 'string') return clampAgentSummary(content);
  const item = object(content);
  if (event.type === 'assistant') {
    const message = item.message ?? content;
    if (typeof message === 'string') return clampAgentSummary(message);
    const fields = object(message);
    if (typeof fields.text === 'string') return clampAgentSummary(fields.text);
    const parts = Array.isArray(fields.content) ? fields.content : [fields.content];
    return clampAgentSummary(parts.map(object).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join(' '));
  }
  if (event.type === 'thinking') return typeof item.text === 'string' ? clampAgentSummary(item.text) : '';
  if (event.type === 'tool_use') {
    const tool = object(item.tool);
    const input = object(tool.input ?? item.input);
    const detail = input.path ?? input.command ?? input.file_path ?? '';
    return clampAgentSummary(String(tool.name ?? item.name ?? '?') + (detail ? ': ' + String(detail) : ''));
  }
  const value = event.type === 'tool_result' ? item.content ?? '' : event.type === 'result' ? item.result ?? content : content;
  return clampAgentSummary(typeof value === 'string' ? value : JSON.stringify(value));
}
