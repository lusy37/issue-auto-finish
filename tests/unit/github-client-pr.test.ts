import { afterEach, expect, it, vi } from "vitest";
import { GitHubClient } from "../../src/clients/GitHubClient.js";
const client = () =>
  new GitHubClient({
    apiUrl: "https://api.github.com",
    token: "test-token",
    repository: "owner/repo",
  });
const response = (body: unknown, status = 200, headers = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const issue = (number: number) => ({
  id: 900000 + number,
  number,
  title: `Issue ${number}`,
  body: "需求描述",
  state: "open",
  labels: [{ name: "bug" }],
  user: { login: "alice" },
  created_at: "2026-09-11",
  updated_at: "2026-09-11",
  html_url: `https://github.com/owner/repo/issues/${number}`,
});
const pull = {
  id: 999,
  number: 7,
  title: "修复",
  state: "open",
  html_url: "https://github.com/owner/repo/pull/7",
  head: { ref: "feat/issue-1" },
  base: { ref: "main" },
};
afterEach(() => vi.restoreAllMocks());
it("使用 GitHub 认证、版本及 PR head/base/body 协议", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(pull));
  expect(
    (
      await client().createPullRequest({
        sourceBranch: "feat/issue-1",
        targetBranch: "main",
        title: "修复",
        description: "验收通过",
      })
    ).number,
  ).toBe(7);
  const [url, options] = fetch.mock.calls[0];
  expect(url).toBe("https://api.github.com/repos/owner/repo/pulls");
  const headers = new Headers(options?.headers);
  expect(headers.get('authorization')).toMatch(/^(token|Bearer) test-token$/);
  expect(headers.get('accept')).toBe('application/vnd.github+json');
  expect(headers.get('x-github-api-version')).toBe('2026-03-10');
  expect(JSON.parse(options?.body as string)).toEqual({
    head: "feat/issue-1",
    base: "main",
    title: "修复",
    body: "验收通过",
  });
});
it("创建 PR 响应丢失时不自动重发", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new TypeError("fetch failed"));
  await expect(
    client().createPullRequest({
      sourceBranch: "x",
      targetBranch: "main",
      title: "x",
    }),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
});
it("按 owner:branch 和目标分支查询已有 PR", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(response([pull]));
  expect(
    (await client().findPullRequestByBranch("feat/issue-1", "main"))?.html_url,
  ).toBe(pull.html_url);
  const url = new URL(String(fetch.mock.calls[0][0]));
  expect(url.searchParams.get("head")).toBe("owner:feat/issue-1");
  expect(url.searchParams.get("base")).toBe("main");
});
it("Issue 分页过滤 PR，使用仓库内 number 并转换标签及作者", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      response(
        Array.from({ length: 100 }, (_, i) =>
          i ? { ...issue(i), pull_request: {} } : issue(1),
        ),
        200, { link: '<https://api.github.com/repos/owner/repo/issues?per_page=100&page=2>; rel="next"' },
      ),
    )
    .mockResolvedValueOnce(response([issue(101)]));
  const result = await client().listIssues();
  expect(result.map((i) => i.number)).toEqual([1, 101]);
  expect(result[0]).toMatchObject({
    id: 900001,
    labels: ["bug"],
    author: { username: "alice" },
    description: "需求描述",
  });
  expect(String(fetch.mock.calls[1][0])).toContain("page=2");
});
it("浏览列表在过滤 PR 后计算搜索结果总数与分页", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    response([issue(1), issue(2), { ...issue(3), pull_request: {} }]),
  );
  expect(
    await client().listIssuesAdvanced({
      search: "需求描述",
      page: 2,
      perPage: 1,
    }),
  ).toMatchObject({ total: 2, issues: [{ number: 2 }] });
});
it("拒绝把 PR 当作普通 Issue 执行", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    response({ ...issue(7), pull_request: {} }),
  );
  await expect(client().getIssueDetail(7)).rejects.toThrow("所选编号是 PR");
});
it("Issue 创建发送 body 与标签数组", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(response(issue(1)));
  await client().createIssue("任务", "需求", ["bug"]);
  expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual({
    title: "任务",
    body: "需求",
    labels: ["bug"],
  });
});
it("缺少自动化标签时先创建，标签更新发送数组", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(response({}, 404))
    .mockResolvedValueOnce(response({ name: "auto-finish" }, 201))
    .mockResolvedValueOnce(response([]));
  await client().updateIssueLabels(42, ["bug", "auto-finish"]);
  expect(String(fetch.mock.calls[1][0])).toContain("/labels");
  expect(JSON.parse(fetch.mock.calls[2][1]?.body as string)).toEqual({
    labels: ["bug", "auto-finish"],
  });
  expect(String(fetch.mock.calls[2][0])).toContain("/issues/42/labels");
});
it("评论删除使用全局 comment ID，并接受 204 空响应", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(response(null, 204));
  await client().deleteIssueNote(42, 1234);
  expect(fetch.mock.calls[0][0]).toBe(
    "https://api.github.com/repos/owner/repo/issues/comments/1234",
  );
  expect(fetch.mock.calls[0][1]?.method).toBe("DELETE");
});
it("PR 对话评论通过 Issue comments 接口发送", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({}));
  await client().createPullRequestNote(7, "结果");
  expect(String(fetch.mock.calls[0][0])).toContain("/issues/7/comments");
});
it("限流要求长等待时返回明确错误，不立即重试", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      response({ message: "rate limited" }, 403, { "retry-after": "60" }),
    );
  await expect(client().getIssueDetail(1)).rejects.toThrow("限流");
  expect(fetch).toHaveBeenCalledOnce();
});
it("GitHub 已合并与可合并状态未知分别转换", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(response({ ...pull, state: "closed", merged: true }))
    .mockResolvedValueOnce(
      response({ ...pull, mergeable: null, mergeable_state: "unknown" }),
    );
  const c = client();
  expect((await c.getPullRequestDetail(7)).state).toBe("merged");
  expect((await c.getPullRequestDetail(8)).has_conflicts).toBe(false);
});

it('读取遇到临时服务错误由 SDK 重试，POST 服务错误也只发一次', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(response({ message: 'temporary failure' }, 503))
    .mockResolvedValueOnce(response(issue(1)))
    .mockResolvedValueOnce(response({ message: 'temporary failure' }, 503));
  const c = client();
  expect((await c.getIssueDetail(1)).number).toBe(1);
  await expect(c.createIssueNote(1, '报告')).rejects.toThrow('503');
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('短期限流由 SDK 等待重试，长限流和 POST 不自动重发', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(response({ message: 'secondary rate limit' }, 429, { 'retry-after': '1' }))
    .mockResolvedValueOnce(response(issue(1)))
    .mockResolvedValueOnce(response({ message: 'secondary rate limit' }, 429, { 'retry-after': '60' }))
    .mockResolvedValueOnce(response({ message: 'secondary rate limit' }, 429, { 'retry-after': '1' }));
  const c = client();
  expect((await c.getIssueDetail(1)).number).toBe(1);
  await expect(c.getIssueDetail(2)).rejects.toMatchObject({ isRateLimited: true, retryAfterMs: 60_000 });
  await expect(c.createIssueNote(1, '报告')).rejects.toThrow('429');
  expect(fetch).toHaveBeenCalledTimes(4);
});

it('并行读取最多四个网络请求，配置刷新后使用新的平台地址', async () => {
  let active = 0;
  let maximum = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await blocked;
    active--;
    return response(issue(1));
  });
  const c = client();
  const pending = Promise.all(Array.from({ length: 8 }, () => c.getIssueDetail(1)));
  try { await vi.waitFor(() => expect(active).toBe(4)); }
  finally { release(); }
  await pending;
  expect(maximum).toBe(4);
  c.updateConfig({ apiUrl: 'https://github.example.com/api/v3', token: 'new-token', repository: 'new/repo' });
  await c.getIssueDetail(1);
  expect(String(fetch.mock.calls.at(-1)?.[0])).toBe('https://github.example.com/api/v3/repos/new/repo/issues/1');
});

it('二级限流缺少等待头时保守交回业务层，不当成普通权限失败', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    response({ message: 'You have exceeded a secondary rate limit.' }, 403),
  );
  await expect(client().getIssueDetail(1)).rejects.toMatchObject({
    isRateLimited: true, retryAfterMs: 60_000,
  });
  expect(fetch).toHaveBeenCalledOnce();
});

it('超过分页预算立即报错，不获取第 101 页或返回不完整结果', async () => {
  let page = 0;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    page++;
    return response([issue(page)], 200, {
      link: `<https://api.github.com/repos/owner/repo/issues?page=${page + 1}>; rel="next"`,
    });
  });
  await expect(client().listIssues()).rejects.toThrow('10000');
  expect(fetch).toHaveBeenCalledTimes(100);
});
