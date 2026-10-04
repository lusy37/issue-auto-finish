import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchIssueDetail } from '../../src/web/frontend/src/api/client.js';
import { json } from '../../src/web/frontend/src/api/http.js';

afterEach(() => vi.unstubAllGlobals());

describe.each([
  { name: '任务接口', invoke: () => fetchIssueDetail(42) },
  { name: '其他面板接口', invoke: () => json('/api/test') },
])('共用请求处理：$name', ({ invoke }) => {
  it('返回成功的 JSON 数据', async () => {
    const data = { title: '测试任务' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(data)));
    await expect(invoke()).resolves.toEqual(data);
  });

  it('遇到 SPA 回退页面时给出明确错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>工作台</html>', {
      headers: { 'Content-Type': 'text/html' },
    })));
    await expect(invoke()).rejects.toThrow('应返回 JSON');
  });

  it('优先使用服务端的错误说明', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: '任务不存在' }, { status: 404 })));
    await expect(invoke()).rejects.toThrow('任务不存在');
  });

  it.each([
    { body: '<html>服务不可用</html>', contentType: 'text/html' },
    { body: '{broken', contentType: 'application/json' },
    { body: 'null', contentType: 'application/json' },
  ])('错误响应无有效说明时保留 HTTP 状态：$body', async ({ body, contentType }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, {
      status: 503,
      headers: { 'Content-Type': contentType },
    })));
    await expect(invoke()).rejects.toThrow('HTTP 503');
  });
});

it.each([false, 0, null])('请求体 %s 应按 JSON 发送', async (body) => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true }));
  vi.stubGlobal('fetch', fetchMock);
  await json('/api/test', 'PUT', body);
  expect(fetchMock).toHaveBeenCalledWith('/api/test', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
});
