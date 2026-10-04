import { Octokit } from '@octokit/rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import pLimit from 'p-limit';
import { GITHUB_MAX_AUTO_WAIT_MS } from '../errors/GitHubPolicy.js';
import { GitHubApiError } from '../errors/index.js';

const GitHubSdk = Octokit.plugin(retry, throttling);

/** 库负责协议、调度和重试；这里仅配置工作台的等待预算及写入策略。 */
export function createGitHubTransport(apiUrl: string, token: string): Pick<Octokit, 'request' | 'paginate'> {
  const limit = pLimit(4);
  const onLimit = (seconds: number, options: { method: string }, _sdk: unknown, attempts: number) =>
    options.method !== 'POST' && seconds * 1000 <= GITHUB_MAX_AUTO_WAIT_MS && attempts < 3;
  const sdk = new GitHubSdk({
    auth: token,
    baseUrl: apiUrl,
    retry: { doNotRetry: [400, 401, 403, 404, 410, 422, 429, 451] },
    throttle: { id: apiUrl, onRateLimit: onLimit, onSecondaryRateLimit: onLimit },
    request: {
      redirect: 'error',
      fetch: (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => limit(() => {
        const timeout = AbortSignal.timeout(30_000);
        const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        signal.throwIfAborted();
        return fetch(url, { ...init, signal });
      }),
    },
  });
  sdk.request = sdk.request.defaults({ headers: {
    accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10',
  } });
  return sdk;
}

/** 将 SDK 错误转换为现有领域错误，保留上层的限流与交付核对行为。 */
export function githubError(error: unknown): Error {
  if (!(error instanceof Error) || !('status' in error))
    return error instanceof Error ? error : new Error(String(error));
  const response = 'response' in error ? error.response as {
    headers: Record<string, string>; data: unknown;
  } | undefined : undefined;
  const headers = response?.headers ?? {};
  const status = Number(error.status);
  const limited = status === 429 || (status === 403 &&
    (headers['retry-after'] !== undefined || headers['x-ratelimit-remaining'] === '0' ||
      /\bsecondary rate\b/i.test(error.message)));
  const wait = headers['retry-after'];
  const delay = wait ? (/^\d+$/.test(wait) ? Number(wait) * 1000 : Date.parse(wait) - Date.now())
    : headers['x-ratelimit-reset'] ? Number(headers['x-ratelimit-reset']) * 1000 - Date.now() : 60_000;
  return new GitHubApiError(status,
    `GitHub 请求失败 ${status}${limited ? '（限流，请稍后重试）' : ''}: ${error.message}`,
    response ? JSON.stringify(response.data) : undefined,
    limited, limited ? Math.max(1000, delay || 60_000) : undefined);
}
