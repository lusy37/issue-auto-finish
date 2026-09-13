import { GitHubApiError } from "../errors/index.js";
import { RetryPolicy } from "../utils/RetryPolicy.js";
import { Semaphore } from "../utils/Semaphore.js";

export interface GitHubConfig {
  apiUrl: string;
  token: string;
  repository: string;
}
/** number 为仓库内编号，id 为全局 ID；其余字段转换为工作台需要的结构。 */
export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  description: string;
  state: string;
  labels: string[];
  created_at: string;
  updated_at: string;
  author: { username: string; name: string };
  assignees?: Array<{ username: string; name: string }>;
  html_url?: string;
}
export interface CreatePullRequestOptions {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description?: string;
}
export interface GitHubPullRequest {
  description?: string;
  source_repository?: string;
  target_repository?: string;
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: string;
  source_branch?: string;
  target_branch?: string;
}
export interface GitHubPullRequestDetail extends GitHubPullRequest {
  has_conflicts: boolean;
  merge_status: string;
}
export interface GitHubNote {
  id: number;
  body: string;
  author: { username: string; name: string };
  created_at: string;
}
interface User {
  login: string;
  name?: string;
}
interface RawIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: Array<string | { name: string }>;
  user: User;
  assignees?: User[];
  created_at: string;
  updated_at: string;
  html_url: string;
  pull_request?: unknown;
}
interface RawPull {
  body?: string;
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: string;
  head: { ref: string; repo?: { full_name: string } };
  base: { ref: string; repo?: { full_name: string } };
  merged?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string;
}
interface RawNote {
  id: number;
  body: string;
  user: User;
  created_at: string;
}
export const AGENT_NOTE_MARKER = "\n\n<!-- issue-auto-finish-agent -->";
const user = (u?: User) => ({
  username: u?.login ?? "",
  name: u?.name ?? u?.login ?? "",
});

export class GitHubClient {
  private config: GitHubConfig;
  private readonly requests = new Semaphore(4);
  private readonly labels = new Set<string>();
  private readonly retry = new RetryPolicy({
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    jitterFactor: 0,
    isRetryable: (error) =>
      error instanceof GitHubApiError
        ? error.isRetryable
        : error instanceof TypeError,
    getBaseDelay: (error) =>
      error instanceof GitHubApiError ? error.retryAfterMs : undefined,
  });
  constructor(config: GitHubConfig) {
    this.config = this.validate(config);
  }
  private validate(config: GitHubConfig): GitHubConfig {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(config.repository) ||
      config.repository.endsWith("/..")
    )
      throw new Error("GitHub 仓库必须是 owner/repo 格式");
    const url = new URL(config.apiUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["http:", "https:"].includes(url.protocol)
    )
      throw new Error("GitHub API 地址格式无效");
    if (!config.token.trim()) throw new Error("GitHub 令牌不能为空");
    return { ...config, apiUrl: config.apiUrl.replace(/\/$/, "") };
  }
  get webBaseUrl(): string {
    const url = new URL(this.config.apiUrl);
    return url.hostname === "api.github.com"
      ? "https://github.com"
      : url.origin;
  }
  get repositoryUrl(): string {
    return `${this.webBaseUrl}/${this.config.repository}`;
  }
  private get base(): string {
    return `${this.config.apiUrl}/repos/${this.config.repository.split("/").map(encodeURIComponent).join("/")}`;
  }
  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const send = async () => {
      const response = await fetch(this.base + endpoint, {
        ...options,
        redirect: "error",
        signal: options.signal ?? AbortSignal.timeout(30000),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.config.token}`,
          "X-GitHub-Api-Version": "2026-03-10",
          "Content-Type": "application/json",
        },
      });
      if (!response.ok) {
        const body = await response.text(),
          wait = response.headers.get("retry-after"),
          reset = response.headers.get("x-ratelimit-reset");
        const limited =
          response.status === 429 ||
          (response.status === 403 &&
            (wait !== null ||
              response.headers.get("x-ratelimit-remaining") === "0"));
        const delay = wait
          ? /^\d+$/.test(wait)
            ? Number(wait) * 1000
            : Math.max(0, Date.parse(wait) - Date.now())
          : reset
            ? Math.max(0, Number(reset) * 1000 - Date.now())
            : 60000;
        throw new GitHubApiError(
          response.status,
          `GitHub 请求失败 ${response.status}${limited ? "（限流，请稍后重试）" : ""}: ${body}`,
          body,
          limited,
          limited ? Math.max(1000, delay || 60000) : undefined,
        );
      }
      return response.status === 204
        ? (undefined as T)
        : ((await response.json()) as T);
    };
    // 创建请求响应丢失时结果未知，由上层核对，禁止自动重发。
    return this.requests.run(() =>
      options.method === "POST" ? send() : this.retry.execute(send, endpoint),
    );
  }
  private issue(raw: RawIssue): GitHubIssue {
    if (raw.pull_request) throw new Error("所选编号是 PR，请选择普通 Issue");
    return {
      id: raw.id,
      number: raw.number,
      title: raw.title,
      description: raw.body ?? "",
      state: raw.state,
      labels: raw.labels.map((l) => (typeof l === "string" ? l : l.name)),
      author: user(raw.user),
      assignees: raw.assignees?.map(user),
      created_at: raw.created_at,
      updated_at: raw.updated_at,
      html_url: raw.html_url,
    };
  }
  private pull(raw: RawPull): GitHubPullRequest {
    return {
      description: raw.body ?? '',
      source_repository: raw.head?.repo?.full_name,
      target_repository: raw.base?.repo?.full_name,
      id: raw.id,
      number: raw.number,
      title: raw.title,
      html_url: raw.html_url || `${this.repositoryUrl}/pull/${raw.number}`,
      state: raw.merged ? "merged" : raw.state,
      source_branch: raw.head?.ref,
      target_branch: raw.base?.ref,
    };
  }
  async checkConnection(): Promise<{
    fullName: string;
    defaultBranch: string;
  }> {
    const repo = await this.request<{
      full_name: string;
      default_branch: string;
    }>("");
    return { fullName: repo.full_name, defaultBranch: repo.default_branch };
  }
  async createIssue(
    title: string,
    description: string,
    labels?: string[],
  ): Promise<GitHubIssue> {
    await this.ensureLabels(labels ?? []);
    return this.issue(
      await this.request<RawIssue>("/issues", {
        method: "POST",
        body: JSON.stringify({ title, body: description, labels }),
      }),
    );
  }
  async listIssues(state = "open", labels?: string): Promise<GitHubIssue[]> {
    const items: GitHubIssue[] = [];
    for (let page = 1; page <= 100; page++) {
      const params = new URLSearchParams({
        state,
        per_page: "100",
        page: String(page),
        sort: "created",
        direction: "asc",
      });
      if (labels) params.set("labels", labels);
      const batch = await this.request<RawIssue[]>(`/issues?${params}`);
      items.push(
        ...batch.filter((i) => !i.pull_request).map((i) => this.issue(i)),
      );
      if (batch.length < 100) return items;
    }
    throw new Error("Issue 超过一次查询的 10000 条上限，请缩小标签或状态范围");
  }
  async listIssuesAdvanced(
    options: {
      state?: string;
      labels?: string;
      search?: string;
      page?: number;
      perPage?: number;
    } = {},
  ): Promise<{ issues: GitHubIssue[]; total: number }> {
    const q = options.search?.trim().toLowerCase();
    const items = (
      await this.listIssues(options.state ?? "open", options.labels)
    ).filter(
      (i) => !q || `${i.title}\n${i.description}`.toLowerCase().includes(q),
    );
    const size = Math.min(100, Math.max(1, options.perPage || 20)),
      start = (Math.max(1, options.page || 1) - 1) * size;
    return { issues: items.slice(start, start + size), total: items.length };
  }
  async getIssueDetail(number: number): Promise<GitHubIssue> {
    return this.issue(await this.request<RawIssue>(`/issues/${number}`));
  }
  async createIssueNote(number: number, body: string): Promise<void> {
    await this.request(`/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: body + AGENT_NOTE_MARKER }),
    });
  }
  private async ensureLabels(labels: string[]): Promise<void> {
    for (const name of labels.filter(
      (l) => l === "auto-finish" || l.startsWith("auto-finish:"),
    )) {
      if (this.labels.has(name)) continue;
      try {
        await this.request(`/labels/${encodeURIComponent(name)}`);
      } catch (error) {
        if (!(error instanceof GitHubApiError) || error.statusCode !== 404)
          throw error;
        try {
          await this.request("/labels", {
            method: "POST",
            body: JSON.stringify({
              name,
              color: "6366f1",
              description: "Issue Auto-Finish 任务状态",
            }),
          });
        } catch (creationError) {
          if (
            !(creationError instanceof GitHubApiError) ||
            creationError.statusCode !== 422
          )
            throw creationError;
          await this.request(`/labels/${encodeURIComponent(name)}`);
        }
      }
      this.labels.add(name);
    }
  }
  async updateIssueLabels(number: number, labels: string[]): Promise<void> {
    await this.ensureLabels(labels);
    await this.request(`/issues/${number}/labels`, {
      method: "PUT",
      body: JSON.stringify({ labels }),
    });
  }
  async addLabel(number: number, label: string): Promise<void> {
    await this.ensureLabels([label]);
    await this.request(`/issues/${number}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels: [label] }),
    });
  }
  async removeLabelsWithPrefix(number: number, prefix: string): Promise<void> {
    const issue = await this.getIssueDetail(number);
    const labels = issue.labels.filter(
      (l) => l !== prefix && !l.startsWith(prefix + ":"),
    );
    if (labels.length !== issue.labels.length)
      await this.updateIssueLabels(number, labels);
  }
  async createPullRequest(
    options: CreatePullRequestOptions,
  ): Promise<GitHubPullRequest> {
    return this.pull(
      await this.request<RawPull>("/pulls", {
        method: "POST",
        body: JSON.stringify({
          head: options.sourceBranch,
          base: options.targetBranch,
          title: options.title,
          body: options.description ?? "",
        }),
      }),
    );
  }
  async findPullRequestByBranch(
    source: string,
    target: string,
    state = "open",
  ): Promise<GitHubPullRequest | null> {
    const head = `${this.config.repository.split("/")[0]}:${source}`;
    const pulls = await this.request<RawPull[]>(
      `/pulls?${new URLSearchParams({ state, head, base: target, per_page: "100" })}`,
    );
    return pulls.length ? this.pull(pulls[0]) : null;
  }
  async getPullRequestDetail(number: number): Promise<GitHubPullRequestDetail> {
    const raw = await this.request<RawPull>(`/pulls/${number}`);
    return {
      ...this.pull(raw),
      has_conflicts: raw.mergeable === false && raw.mergeable_state === "dirty",
      merge_status: raw.mergeable_state ?? "unknown",
    };
  }
  async listPullRequests(): Promise<GitHubPullRequest[]> {
    const result: GitHubPullRequest[] = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await this.request<RawPull[]>(`/pulls?state=all&per_page=100&page=${page}`);
      result.push(...batch.map(raw => this.pull(raw)));
      if (batch.length < 100) return result;
    }
    throw new Error('PR 查询结果不完整，不能可靠核对交付身份');
  }
  async closePullRequest(number: number): Promise<void> {
    await this.request(`/pulls/${number}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
  }
  async closeIssue(number: number): Promise<void> {
    await this.request(`/issues/${number}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
  }
  async createPullRequestNote(number: number, body: string): Promise<void> {
    await this.createIssueNote(number, body);
  }
  async listIssueNotes(number: number): Promise<GitHubNote[]> {
    const result: GitHubNote[] = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await this.request<RawNote[]>(
        `/issues/${number}/comments?per_page=100&page=${page}`,
      );
      result.push(
        ...batch.map((n) => ({
          id: n.id,
          body: n.body ?? "",
          author: user(n.user),
          created_at: n.created_at,
        })),
      );
      if (batch.length < 100) return result;
    }
    throw new Error("评论超过查询上限，无法可靠核对交付结果");
  }
  async deleteIssueNote(_number: number, noteId: number): Promise<void> {
    await this.request(`/issues/comments/${noteId}`, { method: "DELETE" });
  }
  async updateIssueNote(
    _number: number,
    noteId: number,
    body: string,
  ): Promise<void> {
    await this.request(`/issues/comments/${noteId}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    });
  }
  async cleanupAgentNotes(number: number): Promise<number> {
    const notes = (await this.listIssueNotes(number)).filter((n) =>
      n.body.includes(AGENT_NOTE_MARKER.trim()),
    );
    for (const note of notes) await this.deleteIssueNote(number, note.id);
    return notes.length;
  }
  updateConfig(config: GitHubConfig): void {
    this.config = this.validate(config);
    this.labels.clear();
  }
}
