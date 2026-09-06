/** 需求来源类型 */
export type DemandSource = 'github-issue' | 'user-input';

/** 来源标识 — 各来源的原始 ID */
export interface SourceRef {
  readonly source: DemandSource;
  /** 来源系统中的唯一标识（GitHub 仓库内 Issue 编号） */
  readonly externalId: string;
  /** 来源系统中的显示编号（GitHub Issue 编号），可选 */
  readonly displayId?: string;
  /** 来源系统 URL，用于链接回溯 */
  readonly url?: string;
}

/**
 * DemandSpec — 需求规格值对象（知识域核心）
 *
 * 承载"这个需求是什么"，与来源和执行无关。
 * 不可变（readonly），创建后不应修改。
 */
export interface DemandSpec {
  /** 内部唯一标识（系统生成，如 `gh-{number}` 或 UUID） */
  readonly demandId: string;
  /** 需求来源引用 */
  readonly sourceRef: SourceRef;
  /** 需求标题 */
  readonly title: string;
  /** 需求描述（主体内容） */
  readonly description: string;
  /** 结构化补充信息 */
  readonly supplement?: DemandSupplement;
  /** 创建时间 */
  readonly createdAt: string;
}

/** 结构化补充（合并现有 SupplementInfo 的内容字段） */
export interface DemandSupplement {
  readonly requirements?: string;
  readonly acceptanceCriteria?: string;
  readonly scope?: string;
  readonly constraints?: string;
  readonly references?: string;
  readonly freeText?: string;
}
