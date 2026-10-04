import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

/** 所有报告 HTML 共用渲染边界，保留常用 Markdown 元素。 */
export async function renderMarkdown(content: string): Promise<string> {
  return sanitizeHtml(await marked(content), {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'input'],
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      code: ['class'],
      input: ['type', 'checked', 'disabled'],
      img: ['src', 'alt', 'title', 'width', 'height'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
  });
}
