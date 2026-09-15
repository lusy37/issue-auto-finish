import { writeJsonAtomicSync, writeTextAtomicSync } from "../src/utils/atomicFile.js";
import { parse as parseEnv } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { runProcess } from "../src/utils/process.js";
import type { AIRunner, RunOptions } from "../src/ai-runner/AIRunner.js";
import { registerAIRunner } from "../src/ai-runner/AIRunnerRegistry.js";
import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubNote,
} from "../src/clients/GitHubClient.js";
import { main } from "../src/index.js";

/** 可重复操作的本地演示：平台和 AI 使用固定响应，Git、状态机、浏览器验收均真实执行。 */
const root = path.resolve(process.env.IAF_DEMO_DIR || ".iaf-mini/demo-langgraph-v3");
const repo = path.join(root, "repo"),
  origin = path.join(root, "origin.git");
fs.mkdirSync(root, { recursive: true });
const git = async (cwd: string, ...args: string[]) => {
  const result = await runProcess("git", args, { cwd, timeoutMs: 60000 });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "演示仓库 Git 命令失败");
  return result.stdout;
};
if (!fs.existsSync(path.join(repo, ".git"))) {
  fs.mkdirSync(repo, { recursive: true });
  if (!fs.existsSync(origin)) await git(root, "init", "--bare", origin);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Mini Demo");
  await git(repo, "config", "user.email", "demo@example.test");
  fs.writeFileSync(path.join(repo, "README.md"), "# 本地演示项目\n");
  fs.writeFileSync(
    path.join(repo, ".gitignore"),
    "node_modules/\n.iaf-uat-*\n",
  );
  fs.writeFileSync(path.join(repo, "index.html"), "<h1>演示项目</h1>");
  fs.writeFileSync(
    path.join(repo, "serve.mjs"),
    "import http from 'node:http';import fs from 'node:fs';http.createServer((q,s)=>{s.setHeader('content-type','text/html;charset=utf-8');s.end(fs.readFileSync('index.html'));}).listen(Number(process.argv[2]),'127.0.0.1');",
  );
  fs.writeFileSync(
    path.join(repo, "playwright.config.ts"),
    "export default { testDir:'.', testMatch:'acceptance.spec.ts', use:{baseURL:process.env.UAT_BASE_URL,channel:process.env.IAF_TEST_BROWSER_CHANNEL || undefined} };\n",
  );
  fs.writeFileSync(
    path.join(repo, "acceptance.spec.ts"),
    "import {test,expect} from '@playwright/test';test('浏览器验收页面',async({page})=>{await page.goto('/');await expect(page.getByRole('heading')).toHaveText('修复完成');});\n",
  );
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "初始化演示项目");
  await git(repo, "remote", "add", "origin", origin);
  await git(repo, "push", "-u", "origin", "main");
}

const platformPort = Number(process.env.IAF_DEMO_PLATFORM_PORT || 38080);
const platformUrl = `http://127.0.0.1:${platformPort}`;
const author = { username: "demo-github", name: "演示用户" };
type PlatformData = {
  issues: GitHubIssue[];
  prs: GitHubPullRequest[];
  notes: Record<string, GitHubNote[]>;
  failedBranches: string[];
};
const file = path.join(root, "platform.json");
const data: PlatformData = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, "utf8"))
  : { issues: [], prs: [], notes: {}, failedBranches: [] };
const save = () => writeJsonAtomicSync(file, data);
function createIssue(title: string, description: string, labels: string = "") {
  const number =
      Math.max(
        0,
        ...data.issues.map((i) => i.number),
        ...data.prs.map((p) => p.number),
      ) + 1,
    now = new Date().toISOString();
  const issue = {
    id: 10000 + number,
    number,
    title,
    description,
    state: "open",
    labels: labels.split(",").filter(Boolean),
    created_at: now,
    updated_at: now,
    author,
  };
  data.issues.push(issue);
  save();
  return issue;
}
if (!data.issues.length)
  createIssue(
    "演示：实现一个页面",
    "创建显示“修复完成”的页面，运行测试和浏览器验收。",
  );
const app = express();
app.use(express.json());
const api = "/repos/:owner/:repo";
const wireIssue = (i: GitHubIssue) => ({
  id: i.id,
  number: i.number,
  title: i.title,
  body: i.description,
  state: i.state,
  labels: i.labels.map((name) => ({ name })),
  user: { login: i.author.username },
  created_at: i.created_at,
  updated_at: i.updated_at,
  html_url: platformUrl + "/demo/repo/issues/" + i.number,
});
const wirePull = (p: GitHubPullRequest) => ({
  id: p.id,
  number: p.number,
  title: p.title,
  state: p.state,
  html_url: p.html_url,
  body: p.description,
  head: { ref: p.source_branch, repo: { full_name: "demo/repo" } },
  base: { ref: p.target_branch, repo: { full_name: "demo/repo" } },
  mergeable: true,
  mergeable_state: "clean",
});
const labels = new Set(["bug"]);
app.get(api, (_req, res) =>
  res.json({ full_name: "demo/repo", default_branch: "main" }),
);
app.get(api + "/labels/:name", (req, res) =>
  labels.has(req.params.name)
    ? res.json({ name: req.params.name })
    : res.sendStatus(404),
);
app.post(api + "/labels", (req, res) => {
  labels.add(req.body.name);
  res.status(201).json({ name: req.body.name });
});
app.get(api + "/issues", (req, res) => {
  const selected = data.issues.filter(
    (i) =>
      (!req.query.state ||
        req.query.state === "all" ||
        i.state === req.query.state) &&
      (!req.query.labels ||
        String(req.query.labels)
          .split(",")
          .every((l) => i.labels.includes(l))),
  );
  const size = Number(req.query.per_page || 100),
    page = Number(req.query.page || 1);
  res.json(selected.slice((page - 1) * size, page * size).map(wireIssue));
});
app.post(api + "/issues", (req, res) =>
  res
    .status(201)
    .json(
      wireIssue(
        createIssue(
          req.body.title,
          req.body.body,
          (req.body.labels || []).join(","),
        ),
      ),
    ),
);
app.get(api + "/issues/:number", (req, res) => {
  const issue = data.issues.find((i) => i.number === Number(req.params.number));
  res
    .status(issue ? 200 : 404)
    .json(issue ? wireIssue(issue) : { message: "Issue 不存在" });
});
app.patch(api + "/issues/:number", (req, res) => {
  const issue = data.issues.find((i) => i.number === Number(req.params.number));
  if (!issue) {
    res.sendStatus(404);
    return;
  }
  issue.state = req.body.state ?? issue.state;
  save();
  res.json(wireIssue(issue));
});
app.all(api + "/issues/:number/labels", (req, res) => {
  const issue = data.issues.find((i) => i.number === Number(req.params.number));
  if (!issue) {
    res.sendStatus(404);
    return;
  }
  if (req.method === "PUT") issue.labels = req.body.labels;
  else if (req.method === "POST")
    issue.labels = [
      ...new Set([...issue.labels, ...req.body.labels]),
    ] as string[];
  else {
    res.sendStatus(405);
    return;
  }
  save();
  res.json(issue.labels.map((name) => ({ name })));
});
app.get(api + "/issues/:number/comments", (req, res) => {
  const notes = data.notes[req.params.number] || [],
    page = Number(req.query.page || 1);
  res.json(
    notes
      .slice((page - 1) * 100, page * 100)
      .map((n) => ({ ...n, user: { login: n.author.username } })),
  );
});
app.post(api + "/issues/:number/comments", (req, res) => {
  const notes = (data.notes[req.params.number] ??= []);
  const id =
    1 +
    Object.values(data.notes)
      .flat()
      .reduce((max, n) => Math.max(max, n.id), 0);
  const note = {
    id,
    body: req.body.body,
    author,
    created_at: new Date().toISOString(),
  };
  notes.push(note);
  save();
  res.status(201).json({ ...note, user: { login: author.username } });
});
app.all(api + "/issues/comments/:id", (req, res) => {
  for (const notes of Object.values(data.notes)) {
    const index = notes.findIndex((n) => n.id === Number(req.params.id));
    if (index < 0) continue;
    if (req.method === "DELETE") {
      notes.splice(index, 1);
      save();
      res.sendStatus(204);
      return;
    }
    if (req.method === "PATCH") {
      notes[index].body = req.body.body;
      save();
      res.json({ ...notes[index], user: { login: author.username } });
      return;
    }
  }
  res.sendStatus(404);
});
app.get(api + "/pulls", (req, res) =>
  res.json(
    data.prs
      .filter(
        (p) =>
          (!req.query.head || p.source_branch === String(req.query.head).split(":").slice(1).join(":")) &&
          (!req.query.base || p.target_branch === req.query.base),
      )
      .map(wirePull),
  ),
);
app.post(api + "/pulls", (req, res) => {
  const number =
    Math.max(
      0,
      ...data.issues.map((i) => i.number),
      ...data.prs.map((p) => p.number),
    ) + 1;
  const pr = {
    id: 10000 + number,
    number,
    title: req.body.title,
    source_branch: req.body.head,
    target_branch: req.body.base,
    source_repository: "demo/repo",
    target_repository: "demo/repo",
    description: req.body.body,
    state: "open",
    html_url: platformUrl + "/demo/repo/pull/" + number,
  };
  data.prs.push(pr);
  save();
  if (!data.failedBranches.includes(req.body.head)) {
    data.failedBranches.push(req.body.head); save();
    res.status(503).json({ message: "演示：PR 已创建但响应丢失，重试时将核对并复用原 PR" });
    return;
  }
  res.status(201).json(wirePull(pr));
});
app.get(api + "/pulls/:number", (req, res) => {
  const pr = data.prs.find((p) => p.number === Number(req.params.number));
  res.status(pr ? 200 : 404).json(pr ? wirePull(pr) : { message: "PR 不存在" });
});
app.patch(api + "/pulls/:number", (req, res) => {
  const pr = data.prs.find((p) => p.number === Number(req.params.number));
  if (!pr) {
    res.sendStatus(404);
    return;
  }
  pr.state = req.body.state;
  save();
  res.json(wirePull(pr));
});
const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
app.get("/demo/repo/issues/:id", (req, res) =>
  res
    .type("html")
    .send(
      `<meta charset="utf-8"><h1>本地模拟 Issue</h1><pre>${escape(JSON.stringify({ issue: data.issues.find((i) => i.number === Number(req.params.id)), notes: data.notes[req.params.id] }, null, 2))}</pre>`,
    ),
);
app.get("/demo/repo/pull/:id", (req, res) =>
  res.type("html").send(
    `<meta charset="utf-8"><h1>本地模拟合并请求</h1><pre>${escape(
      JSON.stringify(
        data.prs.find((m) => m.number === Number(req.params.id)),
        null,
        2,
      ),
    )}</pre>`,
  ),
);
const server = await new Promise<ReturnType<typeof app.listen>>(
  (resolve, reject) => {
    const server = app.listen(platformPort, "127.0.0.1", (error?: Error) => error ? reject(error) : resolve(server));
    server.on("error", reject);
  },
);

const plan =
  "# 实施计划\n\n## 目标\n实现演示页面，验证错误处理和浏览器展示，在验收通过后创建合并请求。\n\n## 待办\n- [ ] 实现页面\n- [ ] 测试与修复\n- [ ] 浏览器验收\n";
const runner: AIRunner = {
  killAll() {},
  killByWorkDir() {
    return 0;
  },
  async run(options: RunOptions) {
    let output = "";
    if (options.phaseName === 'draft')
      output = JSON.stringify({ title: '实现演示页面', description: '创建演示页面并覆盖错误处理。', acceptanceCriteria: '页面展示修复完成，测试和浏览器验收通过。' });
    else if (options.prompt.includes("你是经验分析专家")) {
      const diaryIds = [
        ...options.prompt.matchAll(/### 日记 \d+ \(ID: ([^)]+)\)/g),
      ].map((m) => m[1]);
      output = JSON.stringify({
        actions: [
          {
            type: "CREATE",
            theme: "failure-pattern",
            title: "交付前验证真实结果",
            content:
              "先验证失败，再修复；浏览器验收读取实际报告。交付失败只重试交付。",
            diaryIds,
          },
        ],
      });
    } else if (options.prompt.includes("你是 AI Agent 规范制定专家")) {
      const sourceMemoryIds = [
        ...options.prompt.matchAll(/### 成熟记忆 \d+ \(ID: ([^)]+)\)/g),
      ].map((m) => m[1]);
      output = JSON.stringify({
        actions: [
          {
            type: "CREATE",
            ruleName: "verify-before-delivery",
            title: "交付前验收",
            content:
              "## 交付规则\n修改后运行测试；浏览器实际通过后才提交合并请求。",
            keywords: ["验收", "交付"],
            alwaysApply: true,
            sourceMemoryIds,
          },
        ],
      });
    } else if (options.mode === "plan")
      output = JSON.stringify({ title: '实现演示页面', description: plan + (options.prompt.includes('反馈') ? '\n已补充边界条件与错误处理。' : ''), acceptanceCriteria: ['标题展示修复完成，浏览器验收通过'], tasks: [{ id: 'page', title: '实现页面', instructions: '实现 index.html 页面和说明，覆盖错误处理', acceptanceCriteria: ['浏览器可访问'], dependsOn: [] }] });
    else {
      const number = options.identity?.issueNumber;
      if (options.phaseName === "build") {
        const html = path.join(options.workDir, "index.html");
        const repair = fs.readFileSync(html, "utf8").includes("待修复");
        fs.writeFileSync(
          html,
          `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><h1>${repair ? "修复完成" : "待修复"}</h1><p>Issue #${number} 的本地演示页面</p></html>`,
        );
        output = repair ? "已修复页面标题" : "已实现页面，等待验证";
      } else if (options.phaseName === "verify") {
        const ok = fs
          .readFileSync(path.join(options.workDir, "index.html"), "utf8")
          .includes("修复完成");
        output = `# 验证报告\n\n**Lint 结果**: 通过\n**Build 结果**: 通过\n**Test 结果**: ${ok ? "通过" : "失败"}\n\n## 结果\n${ok ? "标题符合验收标准。" : "页面标题不符合验收标准，需要改为修复完成。"}\n`;
      } else throw new Error(`演示执行器不支持此调用：${options.phaseName}`);
    }
    options.onStreamEvent?.({
      type: "text",
      content: output,
      timestamp: new Date().toISOString(),
    });
    return { success: true, output, exitCode: 0 };
  },
};
registerAIRunner("codex", {
  factoryFn: () => runner,
  defaultBinary: "",
  binaryEnvKey: "CODEX_BINARY",
  capabilities: { nativePlanMode: true },
});
const configFile = path.join(root, ".env");
const saved = fs.existsSync(configFile) ? parseEnv(fs.readFileSync(configFile)) : {};
// 演示重启保留流程开关；平台、仓库和执行器仍使用演示配置。
const flowSettings = Object.fromEntries(
  ["E2E_UI_ENABLED", "REVIEW_ENABLED", "KNOWLEDGE_ENABLED", "DISTILL_ENABLED", "VERIFY_FIX_LOOP_ENABLED", "VERIFY_FIX_MAX_ITERATIONS", "MAX_CONCURRENT_ISSUES", "AI_MAX_CONCURRENCY", "MAX_RETRIES"]
    .filter(key => saved[key] !== undefined)
    .map(key => [key, saved[key]]),
);
const values = {
  ...flowSettings,
  GITHUB_API_URL: platformUrl,
  GITHUB_TOKEN: "local-demo",
  GITHUB_REPOSITORY: "demo/repo",
  PROJECT_WORK_DIR: repo,
  BASE_BRANCH: "main",
  WORKTREE_BASE_DIR: path.join(root, "worktrees"),
  DATA_DIR: path.join(root, "data"),
  LOGS_DIR: path.join(root, "logs"),
  WEB_PORT: process.env.IAF_DEMO_PORT || "3000",
  PREVIEW_BACKEND_COMMAND: `"${process.execPath}" serve.mjs {port}`,
  PREVIEW_FRONTEND_COMMAND: `"${process.execPath}" serve.mjs {port}`,
  POLL_DRIVE_INTERVAL_MS: "1000",
  POLL_DISCOVERY_INTERVAL_MS: "3000",
  DISTILL_MEMORY_CONFIDENCE_THRESHOLD: "0.2",
  AI_MODEL: "本地模拟响应",
};
Object.assign(process.env, values, {
  IAF_CONFIG_PATH: configFile,
});
writeTextAtomicSync(
  process.env.IAF_CONFIG_PATH!,
  Object.entries(values)
    .map(([k, v]) => `${k}='${v}'`)
    .join("\n"),
);
console.log(
  `本地演示工作台：http://127.0.0.1:${values.WEB_PORT}\n模拟 AI 与平台，真实 Git 和浏览器。`,
);
try {
  await main();
} catch (error) {
  server.close();
  throw error;
}
