import { ref, computed, type Ref } from 'vue';
import type { IssueState, IssueRecord, PipelineMode, PhaseStatus, PlanFileSpec, PipelineMeta } from '@/types';
import { fetchPipelineMeta } from '@/api/client';
import { t } from '@/i18n/index';

// --- 降级用内置默认值 (仅在 API 不可用时使用) ---

const FALLBACK_PLAN_MODE_PHASES = ['plan', 'review', 'build', 'verify', 'uat'];

const FALLBACK_STATE_CATEGORIES: Record<string, string> = {
  skipped: 'skipped',
  pending: 'idle',
  branch_created: 'ready',
  planning: 'running', plan_done: 'ready',
  phase_waiting: 'waiting', phase_approved: 'ready',
  building: 'running', build_done: 'ready',
  verifying: 'running',
  phase_running: 'running', phase_done: 'ready',
  resolving_conflict: 'running',
  completed: 'done',
  failed: 'failed',
  paused: 'paused',
};

// --- 语义分类 → CSS 类映射 (前端 UI 关注点) ---

const CATEGORY_CLASS_MAP: Record<string, string> = {
  idle: 'bg-gray-100 text-gray-600',
  skipped: 'bg-orange-100 text-orange-600',
  ready: 'bg-blue-100 text-blue-600',
  running: 'bg-blue-100 text-blue-600',
  waiting: 'bg-yellow-100 text-yellow-700',
  done: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-600',
  paused: 'bg-amber-100 text-amber-700',
};

// --- Shared meta state ---

const meta = ref<PipelineMeta | null>(null);
let loadPromise: Promise<void> | null = null;

export async function loadPipelineMeta(): Promise<void> {
  if (meta.value) return;
  if (loadPromise) return loadPromise;
  loadPromise = fetchPipelineMeta()
    .then(data => { meta.value = data; })
    .catch(err => {
      console.warn('Failed to load pipeline meta, using fallback', err);
    });
  return loadPromise;
}

export function usePipeline() {
  const pipelineMode = ref<PipelineMode>('plan-mode');

  const phaseNames = computed(() => {
    const mode = pipelineMode.value;
    if (meta.value) {
      return meta.value.modes[mode]?.phases.map(p => p.name) ?? [...FALLBACK_PLAN_MODE_PHASES];
    }
    return [...FALLBACK_PLAN_MODE_PHASES];
  });

  function getPlanDocs(issue?: IssueRecord | null): PlanFileSpec[] {
    const mode = issue?.pipelineMode ?? pipelineMode.value;
    if (meta.value) {
      return meta.value.modes[mode].artifacts.map(a => ({
        file: a.filename,
        label: a.label,
      }));
    }
    // fallback: 基本文件列表
    return [
      { file: '01-plan.md', label: t('planFile.01-plan.md') },
      { file: '02-verify-report.md', label: t('planFile.02-verify-report.md') },
      { file: 'review-feedback.md', label: t('planFile.review-feedback.md') },
    ];
  }

  function getPhaseNames(issue?: IssueRecord | null): string[] {
    const mode = issue?.pipelineMode ?? pipelineMode.value;
    if (meta.value) {
      return meta.value.modes[mode]?.phases.map(p => p.name) ?? [...FALLBACK_PLAN_MODE_PHASES];
    }
    return [...FALLBACK_PLAN_MODE_PHASES];
  }

  function stateLabel(s: IssueState, currentPhase?: string): string {
    if (meta.value?.stateLabels) {
      if ((s === 'phase_running' || s === 'phase_done' || s === 'phase_waiting' || s === 'phase_approved') && currentPhase) {
        const compositeLabel = meta.value.stateLabels[`${s}:${currentPhase}`];
        if (compositeLabel) return compositeLabel;
      }
      if (meta.value.stateLabels[s]) return meta.value.stateLabels[s];
    }
    return t(`state.${s}`) || s;
  }

  function stateClass(s: IssueState): string {
    const categories = meta.value?.stateCategories ?? FALLBACK_STATE_CATEGORIES;
    const category = categories[s] ?? 'idle';
    return CATEGORY_CLASS_MAP[category] ?? CATEGORY_CLASS_MAP.idle;
  }

  function phaseLabel(p: string): string {
    if (meta.value) {
      for (const modeMeta of Object.values(meta.value.modes)) {
        const phase = modeMeta.phases.find(ph => ph.name === p);
        if (phase) return phase.label;
      }
    }
    return t(`phase.${p}`) || p;
  }

  function phaseStatus(issue: IssueRecord, phase: string): PhaseStatus {
    // 优先：使用 tracker 中的真实 phaseProgress（单一数据源）
    if (issue.phaseProgress?.[phase]) {
      return issue.phaseProgress[phase].status;
    }
    // 阶段进度尚未提供时，从进度文件或流水线元数据推导展示状态
    if (issue.progress?.phases?.[phase]) {
      return issue.progress.phases[phase].status;
    }
    const mode = issue.pipelineMode ?? pipelineMode.value;
    if (meta.value) {
      let lookupKey = issue.state as string;
      if ((issue.state === 'phase_running' || issue.state === 'phase_done'
           || issue.state === 'phase_waiting' || issue.state === 'phase_approved'
           || issue.state === 'failed' || issue.state === 'paused') && issue.currentPhase) {
        lookupKey = `${issue.state}:${issue.currentPhase}`;
      }
      const statusMap = meta.value.phaseStatuses[mode]?.[lookupKey];
      if (statusMap) {
        return (statusMap[phase] as PhaseStatus) ?? 'pending';
      }
    }
    return 'pending';
  }

  function phaseIndicatorClass(issue: IssueRecord, phase: string): string {
    const s = phaseStatus(issue, phase);
    if (s === 'completed') return 'bg-green-100 text-green-600';
    if (s === 'in_progress') return 'bg-blue-100 text-blue-600';
    if (s === 'paused') return 'bg-amber-100 text-amber-700';
    if (s === 'failed') return 'bg-red-100 text-red-600';
    return 'bg-gray-100 text-gray-400';
  }

  function phaseNodeClass(status: PhaseStatus): string {
    if (status === 'completed') return 'bg-green-500 text-white';
    if (status === 'in_progress') return 'bg-blue-500 text-white';
    if (status === 'paused') return 'bg-amber-500 text-white';
    if (status === 'failed') return 'bg-red-500 text-white';
    return 'bg-gray-200 text-gray-500';
  }

  function isActiveState(state: IssueState): boolean {
    return !isTerminalState(state);
  }

  function isTerminalState(state: IssueState): boolean {
    const categories = meta.value?.stateCategories ?? FALLBACK_STATE_CATEGORIES;
    const category = categories[state];
    return category === 'done' || category === 'failed' || category === 'skipped';
  }

  function isEditableDoc(filename: string): boolean {
    if (meta.value) {
      return Object.values(meta.value.modes).some(
        m => m.artifacts.some(a => a.filename === filename && a.editable),
      );
    }
    // fallback
    return ['01-plan.md'].includes(filename);
  }

  function issueUrl(number: number, systemStatus: Ref<{ config: { githubBaseUrl: string; repository: string } } | null>): string {
    if (!systemStatus.value) return '#';
    const base = systemStatus.value.config.githubBaseUrl;
    const proj = systemStatus.value.config.repository;
    return `${base}/${proj}/issues/${number}`;
  }

  return {
    pipelineMode,
    phaseNames,
    getPlanDocs,
    getPhaseNames,
    stateLabel,
    stateClass,
    phaseLabel,
    phaseStatus,
    phaseIndicatorClass,
    phaseNodeClass,
    isActiveState,
    isTerminalState,
    isEditableDoc,
    issueUrl,
  };
}
