/** 所有 JSON 接口共用响应校验与错误处理。 */
export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error(response.ok
      ? `接口 ${url} 应返回 JSON，实际收到 ${contentType || '未知响应类型'}`
      : `HTTP ${response.status}`);
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
    throw new Error(typeof message === 'string' && message ? message : `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

/** 按方法与请求体调用 JSON 接口，保留 false、0、null 等有效请求体。 */
export function json<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  return request<T>(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
