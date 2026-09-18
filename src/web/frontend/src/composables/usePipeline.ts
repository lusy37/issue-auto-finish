import { computed, ref, type Ref } from 'vue';
import type { IssueLifecycle, IssueRecord, PipelineMode, PhaseStatus, PlanFileSpec, PipelineMeta } from '@/types';
import { fetchPipelineMeta } from '@/api/client';
import { t } from '@/i18n/index';

const FALLBACK_PLAN_MODE_PHASES = ['plan', 'review', 'build', 'verify', 'uat'];

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

const meta = ref<PipelineMeta | null>(null);
let loadPromise: Promise<void> | null = null;

export async function loadPipelineMeta(): Promise<void> {
  if (meta.value) return;
  if (loadPromise) return loadPromise;
  loadPromise = fetchPipelineMeta()
    .then(data => { meta.value = data; })
    .catch(err => { console.warn('Failed to load pipeline meta, using fallback', err); });
  return loadPromise;
}

function lifecycleCategory(lifecycle: IssueLifecycle): string {
  switch (lifecycle.kind) {
    case 'pending': return 'idle';
    case 'skipped':
    case 'cancelled': return 'skipped';
    case 'ready':
    case 'delivering': return 'ready';
    case 'running': return 'running';
    case 'waiting': return 'waiting';
    case 'paused': return 'paused';
    case 'failed': return 'failed';
    case 'completed': return 'done';
  }
}

export function usePipeline() {
  const pipelineMode = ref<PipelineMode>('plan-mode');

  const phaseNames = computed(() => {
    const mode = pipelineMode.value;
    return meta.value?.modes[mode]?.phases.map(p => p.name) ?? [...FALLBACK_PLAN_MODE_PHASES];
  });

  function getPlanDocs(issue?: IssueRecord | null): PlanFileSpec[] {
    if (issue?.planDocs) return issue.planDocs;
    const mode = issue?.pipelineMode ?? pipelineMode.value;
    if (meta.value?.modes[mode]) {
      return meta.value.modes[mode].artifacts.map(a => ({ file: a.filename, label: a.label }));
    }
    return [
      { file: '01-plan.md', label: t('planFile.01-plan.md') },
      { file: '02-verify-report.md', label: t('planFile.02-verify-report.md') },
      { file: 'review-feedback.md', label: t('planFile.review-feedback.md') },
    ];
  }

  function getPhaseNames(issue?: IssueRecord | null): string[] {
    if (issue?.phaseProgress) return Object.keys(issue.phaseProgress);
    const mode = issue?.pipelineMode ?? pipelineMode.value;
    return meta.value?.modes[mode]?.phases.map(p => p.name) ?? [...FALLBACK_PLAN_MODE_PHASES];
  }

  function phaseLabel(phase: string): string {
    for (const modeMeta of Object.values(meta.value?.modes ?? {})) {
      const found = modeMeta.phases.find(item => item.name === phase);
      if (found) return found.label;
    }
    return t(`phase.${phase}`) || phase;
  }

  function stateLabel(lifecycle: IssueLifecycle): string {
    if ('phase' in lifecycle && lifecycle.phase) {
      const label = phaseLabel(lifecycle.phase);
      if (lifecycle.kind === 'running') return t('state.phaseDoing', { label });
      if (lifecycle.kind === 'waiting') return t('state.phaseWaiting', { label });
    }
    switch (lifecycle.kind) {
      case 'pending': return t('state.pending');
      case 'skipped': return t('state.skipped');
      case 'ready': return t('state.ready');
      case 'paused': return t('state.paused');
      case 'failed': return t('state.failed');
      case 'delivering': return t('state.delivering');
      case 'completed': return t('state.completed');
      case 'cancelled': return t('state.cancelled');
    }
  }

  function stateClass(lifecycle: IssueLifecycle): string {
    return CATEGORY_CLASS_MAP[lifecycleCategory(lifecycle)] ?? CATEGORY_CLASS_MAP.idle;
  }

  function phaseStatus(issue: IssueRecord, phase: string): PhaseStatus {
    const persisted = issue.phaseProgress?.[phase];
    if (persisted) return persisted.status;

    const phases = getPhaseNames(issue);
    if (issue.lifecycle.kind === 'completed') return 'completed';
    const activePhase = 'phase' in issue.lifecycle ? issue.lifecycle.phase : undefined;
    if (!activePhase) return 'pending';
    const targetIndex = phases.indexOf(phase);
    const activeIndex = phases.indexOf(activePhase);
    if (targetIndex < 0 || activeIndex < 0) return 'pending';
    if (targetIndex < activeIndex) return 'completed';
    if (targetIndex > activeIndex) return 'pending';
    if (issue.lifecycle.kind === 'waiting') return 'gate_waiting';
    if (issue.lifecycle.kind === 'failed') return 'failed';
    if (issue.lifecycle.kind === 'paused') return 'paused';
    return 'in_progress';
  }

  function phaseIndicatorClass(issue: IssueRecord, phase: string): string {
    const status = phaseStatus(issue, phase);
    if (status === 'completed') return 'bg-green-100 text-green-600';
    if (status === 'in_progress') return 'bg-blue-100 text-blue-600';
    if (status === 'paused') return 'bg-amber-100 text-amber-700';
    if (status === 'failed') return 'bg-red-100 text-red-600';
    return 'bg-gray-100 text-gray-400';
  }

  function phaseNodeClass(status: PhaseStatus): string {
    if (status === 'completed') return 'bg-green-500 text-white';
    if (status === 'in_progress') return 'bg-blue-500 text-white';
    if (status === 'paused') return 'bg-amber-500 text-white';
    if (status === 'failed') return 'bg-red-500 text-white';
    return 'bg-gray-200 text-gray-500';
  }

  function isTerminalState(lifecycle: IssueLifecycle): boolean {
    return ['completed', 'failed', 'skipped', 'cancelled'].includes(lifecycle.kind);
  }

  function isActiveState(lifecycle: IssueLifecycle): boolean {
    return !isTerminalState(lifecycle);
  }

  function isEditableDoc(filename: string): boolean {
    if (meta.value) {
      return Object.values(meta.value.modes).some(
        mode => mode.artifacts.some(artifact => artifact.filename === filename && artifact.editable),
      );
    }
    return filename === '01-plan.md';
  }

  function issueUrl(number: number, systemStatus: Ref<{ config: { githubBaseUrl: string; repository: string } } | null>): string {
    if (!systemStatus.value) return '#';
    const { githubBaseUrl, repository } = systemStatus.value.config;
    return `${githubBaseUrl}/${repository}/issues/${number}`;
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
