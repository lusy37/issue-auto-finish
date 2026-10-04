import { expect, it } from 'vitest';
import { renderMarkdown } from '../../src/web/renderMarkdown.js';

it('报告保留表格、代码、图片和只读任务清单', async () => {
  const html = await renderMarkdown('| 检查 | 结果 |\n| --- | --- |\n| 构建 | 通过 |\n\n```ts\nconst ok = true;\n```\n\n- [x] 验收\n\n![报告](https://example.com/report.png)');
  expect(html).toContain('<table>');
  expect(html).toContain('class="language-ts"');
  expect(html).toContain('type="checkbox"');
  expect(html).toContain('disabled');
  expect(html).toContain('src="https://example.com/report.png"');
});

it('报告移除脚本、事件属性、危险链接和嵌入式执行元素', async () => {
  const html = await renderMarkdown('<script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">链接</a><iframe src="https://example.com"></iframe><svg onload="alert(4)"></svg>');
  expect(html).toContain('链接');
  expect(html).not.toMatch(/script|onerror|javascript:|iframe|svg|onload/);
});
