/**
 * Knowledge Distillation Pipeline — 知识蒸馏管道数据类型定义。
 *
 * 四层结构：Diary → Memory → AgentRule → Vector
 */

// ---------------------------------------------------------------------------
// Layer 1: Diary (日记) — 原始 Issue 经验记录
// ---------------------------------------------------------------------------

export interface DiaryPhaseTiming {
  phase: string;
  durationMs: number;
  retries: number;
}

export interface DiaryTiming {
  totalDurationMs: number;
  phaseTimings: DiaryPhaseTiming[];
  startedAt: string;
  finishedAt: string;
}

export interface DiaryFailure {
  failedAtPhase: string;
  error: string;
  attempts: number;
}

export interface DiaryHumanIntervention {
  type: 'review-approve' | 'review-reject' | 'retry' | 'supplement';
  detail: string;
  timestamp: string;
}

export interface DiaryEntry {
  executionKey?: string;
  id: string;
  issueIid: number;
  issueTitle: string;
  branchName: string;
  pipelineMode: string;

  /** 结果 */
  outcome: 'completed' | 'failed';
  prUrl?: string;

  /** 执行效率 */
  timing: DiaryTiming;

  /** 失败信息（仅 outcome='failed' 时） */
  failure?: DiaryFailure;

  /** 人工介入记录 */
  humanInterventions: DiaryHumanIntervention[];

  /** 阶段产物摘要（AI 生成的精简版，可选） */
  artifactSummary?: string;

  /** 是否已被 Layer 2 (MemoryDistiller) 处理 */
  distilled: boolean;

  createdAt: string;
}

// ---------------------------------------------------------------------------
// Layer 2: Memory (记忆) — 蒸馏后的共性模式
// ---------------------------------------------------------------------------

export type MemoryTheme =
  | 'failure-pattern'
  | 'efficiency-insight'
  | 'intervention-pattern'
  | 'optimization-suggestion'
  | 'rejection-pattern';

export interface MemoryEntry {
  id: string;
  theme: MemoryTheme;
  title: string;
  /** Markdown 格式的模式描述 */
  content: string;
  /** 关联的 diary ID 列表 */
  evidence: string[];
  /** 0-1，被多少日记佐证 */
  confidence: number;
  /** 版本号，合并时递增 */
  version: number;
  /** 被替代的旧 memory ID */
  supersedes?: string;
  /** 是否已提升为 agent-rule */
  promotedToRule: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Layer 3: AgentRule (Agent 规则) — 可执行的 AI Agent 准则
// ---------------------------------------------------------------------------

export interface AgentRuleEntry {
  id: string;
  /** 规则文件名（不含扩展名） */
  ruleName: string;
  title: string;
  /** Markdown 规则内容 */
  content: string;
  /** 来源 memory ID 列表 */
  sourceMemoryIds: string[];
  /** 触发关键词 */
  keywords: string[];
  /** 是否总是应用 */
  alwaysApply: boolean;
  version: number;
  /** AI 判断已过时 */
  deprecated: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Version History — 知识退役支持
// ---------------------------------------------------------------------------

export interface VersionRecord {
  entryId: string;
  version: number;
  content: string;
  action: 'created' | 'merged' | 'superseded' | 'deprecated';
  reason?: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// AI Distill Actions — AI 蒸馏输出结构
// ---------------------------------------------------------------------------

export type MemoryDistillAction =
  | { type: 'CREATE'; theme: MemoryTheme; title: string; content: string; diaryIds: string[] }
  | { type: 'MERGE'; memoryId: string; newEvidence: string[]; updatedContent?: string }
  | { type: 'SUPERSEDE'; oldMemoryId: string; theme: MemoryTheme; title: string; content: string; diaryIds: string[] };

export type RuleDistillAction =
  | { type: 'CREATE'; ruleName: string; title: string; content: string; keywords: string[]; alwaysApply: boolean; sourceMemoryIds: string[] }
  | { type: 'UPDATE'; ruleId: string; content: string; keywords?: string[] }
  | { type: 'DEPRECATE'; ruleId: string; reason: string };
