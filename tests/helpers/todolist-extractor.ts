export interface TodoItem {
  /** 提取结果中的零基索引。 */
  index: number;
  /** 是否已勾选。 */
  completed: boolean;
  /** 去掉复选框语法后的文本。 */
  text: string;
  /** 缩进层级。 */
  depth: number;
}

export interface TodolistSummary {
  items: TodoItem[];
  total: number;
  completed: number;
  pending: number;
}

const CHECKBOX_RE = /^(\s*)[-*]\s+\[([ xX])\]\s+(.+)$/;

export function extractTodolist(markdown: string): TodolistSummary {
  const items: TodoItem[] = [];
  for (const line of markdown.split('\n')) {
    const match = CHECKBOX_RE.exec(line);
    if (!match) continue;
    items.push({
      index: items.length,
      completed: match[2].toLowerCase() === 'x',
      text: match[3].trim(),
      depth: Math.floor(match[1].length / 2),
    });
  }
  const completed = items.filter((item) => item.completed).length;
  return { items, total: items.length, completed, pending: items.length - completed };
}

export function renderTodolistMarkdown(summary: TodolistSummary): string {
  return summary.items.map((item) => {
    const checkbox = item.completed ? '[x]' : '[ ]';
    return `${'  '.repeat(item.depth)}- ${checkbox} ${item.text}`;
  }).join('\n');
}

export function todolistProgressText(summary: TodolistSummary): string {
  if (summary.total === 0) return '无 Todolist 项';
  const percent = Math.round((summary.completed / summary.total) * 100);
  return `${summary.completed}/${summary.total} 完成 (${percent}%)`;
}
