import express from "express";
import {createApp} from "./createApp.js";
import type { Server } from "node:http";
import { createApiRouter, type ApiRouterDeps } from "./routes/api.js";
import { createSetupRouter } from "./routes/setup.js";
import { createKnowledgeRouter } from "./routes/knowledge.js";
import { createDistillRouter } from "./routes/distill.js";
import { createDraftRouter } from "./routes/drafts.js";
import { createAnalyticsRouter } from "./routes/analytics.js";
import { createUatRouter } from "./routes/uat.js";
import type { AIRunner } from "../ai-runner/AIRunner.js";
import type { KnowledgeStore } from "../knowledge/KnowledgeStore.js";
import type { DiaryStore } from "../distill/DiaryStore.js";
export interface WebServerDeps extends ApiRouterDeps {
  aiRunner: AIRunner;
  knowledgeStore: KnowledgeStore;
  diaryStore: DiaryStore;
}
export class WebServer {
  private app: express.Express;
  private server?: Server;
  constructor(private deps: WebServerDeps) {
    this.app=createApp(deps.config.web.frontendDistDir,[
      createApiRouter(deps), createSetupRouter(deps.config),
      createKnowledgeRouter(deps.knowledgeStore),
      createDistillRouter({config:deps.config,diaryStore:deps.diaryStore,distillScheduler:deps.distillScheduler}),
      createDraftRouter(deps.aiRunner,deps.github,deps.config),
      createAnalyticsRouter(deps.tracker,deps.config), createUatRouter(),
    ]);
  }
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(
        this.deps.config.web.port,
        this.deps.config.web.host,
        resolve,
      );
      this.server.once("error", reject);
    });
  }
  getPort(): number {
    const address = this.server?.address();
    if (!address || typeof address === "string")
      throw new Error("工作台尚未启动");
    return address.port;
  }
  stop(): void {
    this.server?.closeAllConnections();
    this.server?.close();
  }
}
