import { logger as rootLogger } from '../logger.js';

const logger = rootLogger.child('TodolistExtractor');

export interface TodoItem {
  /** Zero-based index in the extracted list */
  index: number;
  /** Whether the checkbox is checked (- [x]) */
  completed: boolean;
  /** The text content of the todo item (without the checkbox syntax) */
  text: string;
  /** Nesting depth (0 = top-level, 1 = sub-item, etc.) */
  depth: number;
}

export interface TodolistSummary {
  items: TodoItem[];
  total: number;
  completed: number;
  pending: number;
}

const CHECKBOX_RE = /^(\s*)[-*]\s+\[([ xX])\]\s+(.+)$/;

/**
 * Extracts structured todolist items from a Markdown plan document.
 * Recognizes standard GitHub-flavored checkbox syntax: `- [ ] text` / `- [x] text`
 */
export function extractTodolist(markdown: string): TodolistSummary {
  const lines = markdown.split('\n');
  const items: TodoItem[] = [];
  let index = 0;

  for (const line of lines) {
    const match = CHECKBOX_RE.exec(line);
    if (!match) continue;

    const indent = match[1].length;
    const checked = match[2].toLowerCase() === 'x';
    const text = match[3].trim();

    items.push({
      index: index++,
      completed: checked,
      text,
      depth: Math.floor(indent / 2),
    });
  }

  const completed = items.filter(i => i.completed).length;
  const summary: TodolistSummary = {
    items,
    total: items.length,
    completed,
    pending: items.length - completed,
  };

  logger.debug('Todolist extracted', {
    total: summary.total,
    completed: summary.completed,
    pending: summary.pending,
  });

  return summary;
}

/**
 * Render a TodolistSummary back to Markdown checkbox format.
 * Useful for status display in comments or Web UI.
 */
export function renderTodolistMarkdown(summary: TodolistSummary): string {
  const lines: string[] = [];
  for (const item of summary.items) {
    const indent = '  '.repeat(item.depth);
    const checkbox = item.completed ? '[x]' : '[ ]';
    lines.push(`${indent}- ${checkbox} ${item.text}`);
  }
  return lines.join('\n');
}

/**
 * Generate a progress string like "5/8 完成 (62%)"
 */
export function todolistProgressText(summary: TodolistSummary): string {
  if (summary.total === 0) return '无 Todolist 项';
  const pct = Math.round((summary.completed / summary.total) * 100);
  return `${summary.completed}/${summary.total} 完成 (${pct}%)`;
}
