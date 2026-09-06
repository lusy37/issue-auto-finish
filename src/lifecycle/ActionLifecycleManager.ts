import { IssueState } from '../tracker/IssueState.js';
import type { PipelineDef, PhaseSpec, PlanFileSpec } from '../pipeline/PipelineDefinition.js';
import type { ActionState, ActionStatus } from './ActionLifecycle.js';
import { t } from '../i18n/index.js';

/**
 * ActionLifecycleManager — 查询层抽象。
 *
 * 从 PipelineDef 自动构建 IssueState ↔ ActionState 双向映射表，
 * 集中散布在 IssueTracker/PipelineOrchestrator/BasePhase 中的状态分类逻辑。
 *
 * 不改变持久化格式（tracker.json 中的状态字符串值完全保留）。
 */
export class ActionLifecycleManager {
  /** IssueState → ActionState */
  private readonly stateToAction: Map<IssueState, ActionState>;
  /** "action:status" → IssueState */
  private readonly actionToState: Map<string, IssueState>;
  /** phase name → { startState, doneState, approvedState? } */
  private readonly phaseStatesMap: Map<string, { startState: IssueState; doneState: IssueState; approvedState?: IssueState }>;
  /** Ordered phase indices by IssueState for determineResumePhaseIndex */
  private readonly def: PipelineDef;

  constructor(def: PipelineDef) {
    this.def = def;
    this.stateToAction = new Map();
    this.actionToState = new Map();
    this.phaseStatesMap = new Map();

    this.buildMappings(def);
  }

  private buildMappings(def: PipelineDef): void {
    // Fixed mappings
    this.addMapping(IssueState.Pending, 'init', 'idle');
    this.addMapping(IssueState.Cancelled, 'cancel', 'skipped');
    this.addMapping(IssueState.Delivering, 'delivery', 'ready');
    this.addMapping(IssueState.Skipped, 'init', 'skipped');
    this.addMapping(IssueState.BranchCreated, 'init', 'ready');
    this.addMapping(IssueState.Failed, 'init', 'failed');
    this.addMapping(IssueState.Paused, 'init', 'paused');
    this.addMapping(IssueState.ResolvingConflict, 'conflict', 'running');

    // Phase-driven mappings
    for (const spec of def.phases) {
      this.phaseStatesMap.set(spec.name, {
        startState: spec.startState,
        doneState: spec.doneState,
        approvedState: spec.approvedState,
      });

      if (spec.kind === 'ai') {
        // For generic PhaseRunning/PhaseDone, don't add to stateToAction map
        // (since multiple phases share the same IssueState value).
        // Only add non-generic states.
        if (spec.startState !== IssueState.PhaseRunning) {
          this.addMapping(spec.startState, spec.name, 'running');
        }
        if (spec.doneState === IssueState.Completed) {
          this.addMapping(spec.doneState, spec.name, 'done');
        } else if (spec.doneState !== IssueState.PhaseDone) {
          this.addMapping(spec.doneState, spec.name, 'ready');
        }
      } else if (spec.kind === 'gate') {
        // For generic PhaseWaiting/PhaseApproved, don't add to stateToAction map
        // (since multiple gate phases could share the same IssueState value).
        if (spec.startState !== IssueState.PhaseWaiting) {
          this.addMapping(spec.startState, spec.name, 'waiting');
        }
        if (spec.approvedState && spec.approvedState !== IssueState.PhaseApproved) {
          this.addMapping(spec.approvedState, spec.name, 'ready');
        }
      }
    }
  }

  private addMapping(state: IssueState, action: string, status: ActionStatus): void {
    // Avoid overwriting — first mapping wins (e.g. Completed mapped by verify phase)
    if (!this.stateToAction.has(state)) {
      this.stateToAction.set(state, { action, status });
    }
    const key = `${action}:${status}`;
    if (!this.actionToState.has(key)) {
      this.actionToState.set(key, state);
    }
  }

  // ─── Query API ───

  /**
   * 将 IssueState 解析为语义化的 ActionState。
   *
   * 对于通用状态 PhaseRunning/PhaseDone，需额外传入 currentPhase 来区分具体阶段。
   */
  resolve(state: IssueState, currentPhase?: string): ActionState {
    // Paused：用 pausedAtPhase（传入的 currentPhase）作为 action 名
    if (state === IssueState.Paused && currentPhase) {
      return { action: currentPhase, status: 'paused' };
    }
    // 通用阶段状态：用 currentPhase 作为 action 名
    if (state === IssueState.PhaseRunning && currentPhase) {
      return { action: currentPhase, status: 'running' };
    }
    if (state === IssueState.PhaseDone && currentPhase) {
      return { action: currentPhase, status: 'ready' };
    }
    if (state === IssueState.PhaseWaiting && currentPhase) {
      return { action: currentPhase, status: 'waiting' };
    }
    if (state === IssueState.PhaseApproved && currentPhase) {
      return { action: currentPhase, status: 'ready' };
    }

    const mapped = this.stateToAction.get(state);
    if (mapped) return mapped;
    // Fallback: unknown states (from another pipeline mode) treated as idle
    return { action: 'init', status: 'idle' };
  }

  /**
   * 将 action + status 反向映射为 IssueState。
   */
  toIssueState(action: string, status: ActionStatus): IssueState | undefined {
    return this.actionToState.get(`${action}:${status}`);
  }

  // ─── Classification predicates (替代 3 个 Set 常量 + getDrivableIssues) ───

  /**
   * 终态：done | failed | skipped
   */
  isTerminal(state: IssueState): boolean {
    const as = this.resolve(state);
    return as.status === 'done' || as.status === 'failed' || as.status === 'skipped';
  }

  /**
   * 进行中：running (包含通用 PhaseRunning)
   */
  isInProgress(state: IssueState): boolean {
    if (state === IssueState.PhaseRunning) return true;
    return this.resolve(state).status === 'running';
  }

  /**
   * 阻塞中：waiting
   */
  isBlocked(state: IssueState): boolean {
    if (state === IssueState.PhaseWaiting) return true;
    return this.resolve(state).status === 'waiting';
  }

  /**
   * 可驱动判断（集中化 getDrivableIssues 的过滤逻辑）。
   *
   * - idle → 可驱动 (Pending)
   * - ready → 可驱动 (BranchCreated, PhaseDone, PhaseApproved)
   * - failed && attempts < maxRetries → 可驱动
   * - waiting → 不可驱动 (PhaseWaiting)
   * - running → 不可驱动（stalled 由外部叠加）
   * - done/skipped → 不可驱动
   */
  isDrivable(state: IssueState, attempts: number, maxRetries: number, lastErrorRetryable?: boolean): boolean {
    // Paused is never drivable (user must explicitly continue/redo)
    if (state === IssueState.Paused) return false;
    // PhaseDone is always drivable (triggers next phase)
    if (state === IssueState.PhaseDone) return true;
    // PhaseApproved is always drivable (gate approved, triggers next phase)
    if (state === IssueState.PhaseApproved) return true;
    // PhaseRunning is never drivable (something is executing)
    if (state === IssueState.PhaseRunning) return false;
    // PhaseWaiting is never drivable (waiting for external input)
    if (state === IssueState.PhaseWaiting) return false;
    const as = this.resolve(state);
    switch (as.status) {
      case 'idle':
      case 'ready':
        return true;
      case 'failed':
        if (lastErrorRetryable === false) return false;
        return attempts < maxRetries;
      case 'waiting':
      case 'running':
      case 'done':
      case 'skipped':
      case 'paused':
        return false;
    }
  }

  // ─── Phase navigation (替代 determineStartIndex + getPhasePreState) ───

  /**
   * 确定从哪个阶段索引恢复执行（替代 PipelineOrchestrator.determineStartIndex）。
   *
   * 从后向前扫描 phases，匹配 currentState 或 failedAtState。
   * 支持通用状态 PhaseRunning/PhaseDone + currentPhase 的组合。
   */
  determineResumePhaseIndex(currentState: IssueState, failedAtState?: IssueState, currentPhase?: string): number {
    const target = failedAtState || currentState;
    const phases = this.def.phases;

    // 通用阶段状态：通过 currentPhase 名称匹配
    if ((target === IssueState.PhaseRunning || target === IssueState.PhaseDone) && currentPhase) {
      const idx = phases.findIndex(p => p.name === currentPhase);
      if (idx >= 0) {
        return target === IssueState.PhaseDone ? idx + 1 : idx;
      }
    }
    if ((target === IssueState.PhaseWaiting || target === IssueState.PhaseApproved) && currentPhase) {
      const idx = phases.findIndex(p => p.name === currentPhase);
      if (idx >= 0) {
        if (target === IssueState.PhaseApproved) {
          const spec = phases[idx];
          // AI phase with approvedState: re-execute same phase (detection done, execution pending)
          return (spec.kind === 'ai' && spec.approvedState) ? idx : idx + 1;
        }
        return idx;
      }
    }

    for (let i = phases.length - 1; i >= 0; i--) {
      const spec = phases[i];

      if (spec.kind === 'gate' && spec.approvedState === target) {
        return i + 1;
      }

      if (spec.startState === target || spec.doneState === target) {
        return spec.doneState === target ? i + 1 : i;
      }
    }
    return 0;
  }

  /**
   * 获取某个 phase 的前驱状态（即重置到该 phase 需要设置的状态）。
   * 第一个 phase 的前驱是 BranchCreated；后续 phase 的前驱是上一个 phase 的 approvedState 或 doneState。
   */
  getPhasePreState(phaseName: string): IssueState | undefined {
    const phases = this.def.phases;
    const idx = phases.findIndex(p => p.name === phaseName);
    if (idx < 0) return undefined;
    if (idx === 0) return IssueState.BranchCreated;
    const prev = phases[idx - 1];
    return prev.approvedState ?? prev.doneState;
  }

  /**
   * 获取某个 phase 的状态三元组。
   */
  getPhaseStates(phaseName: string): { startState: IssueState; doneState: IssueState; approvedState?: IssueState } | undefined {
    return this.phaseStatesMap.get(phaseName);
  }

  // ─── Display helpers (替代 collectStateLabels + derivePhaseStatuses) ───

  /**
   * 解析单条状态的展示标签。
   *
   * 对通用状态 PhaseRunning/PhaseDone，需传入 currentPhase 以生成具体标签（如"分析中"）；
   * 缺少 currentPhase 时回退到泛化标签（如"阶段执行中"）。
   */
  resolveLabel(state: IssueState, currentPhase?: string): string {
    if ((state === IssueState.PhaseRunning || state === IssueState.PhaseDone) && currentPhase) {
      const phaseLabel = t(`pipeline.phase.${currentPhase}`);
      return state === IssueState.PhaseRunning
        ? t('state.phaseDoing', { label: phaseLabel })
        : t('state.phaseDone', { label: phaseLabel });
    }
    if ((state === IssueState.PhaseWaiting || state === IssueState.PhaseApproved) && currentPhase) {
      const phaseLabel = t(`pipeline.phase.${currentPhase}`);
      return state === IssueState.PhaseWaiting
        ? t('state.phaseWaiting', { label: phaseLabel })
        : t('state.phaseApproved', { label: phaseLabel });
    }
    const labels = this.collectStateLabels();
    return labels.get(state) ?? state;
  }

  /**
   * 收集所有状态及其展示标签。
   * 为通用状态 PhaseRunning/PhaseDone 生成每个阶段的复合 key 条目。
   */
  collectStateLabels(): Map<string, string> {
    const labels = new Map<string, string>();
    labels.set(IssueState.Pending, t('state.pending'));
    labels.set(IssueState.Skipped, t('state.skipped'));
    labels.set(IssueState.BranchCreated, t('state.branchCreated'));

    for (const phase of this.def.phases) {
      const phaseLabel = t(`pipeline.phase.${phase.name}`);

      // AI 阶段: PhaseRunning/PhaseDone → composite key
      if (phase.startState === IssueState.PhaseRunning) {
        labels.set(`phase_running:${phase.name}`, t('state.phaseDoing', { label: phaseLabel }));
      } else if (phase.startState === IssueState.PhaseWaiting) {
        // Gate 阶段: PhaseWaiting → composite key
        labels.set(`phase_waiting:${phase.name}`, t('state.phaseWaiting', { label: phaseLabel }));
      } else {
        labels.set(phase.startState, t('state.phaseDoing', { label: phaseLabel }));
      }

      if (phase.doneState === IssueState.PhaseDone) {
        labels.set(`phase_done:${phase.name}`, t('state.phaseDone', { label: phaseLabel }));
      } else if (phase.doneState === IssueState.PhaseApproved) {
        // Gate 阶段: PhaseApproved → composite key
        labels.set(`phase_approved:${phase.name}`, t('state.phaseApproved', { label: phaseLabel }));
      } else if (phase.doneState !== IssueState.Completed) {
        labels.set(phase.doneState, t('state.phaseDone', { label: phaseLabel }));
      }

      // 非通用 approvedState（保留，支持自定义状态）
      if (phase.approvedState
          && phase.approvedState !== IssueState.PhaseApproved
          && phase.approvedState !== phase.doneState) {
        labels.set(phase.approvedState, t('state.phaseApproved', { label: phaseLabel }));
      }
    }

    labels.set(IssueState.Completed, t('state.completed'));
    labels.set(IssueState.Delivering, '正在交付');
    labels.set(IssueState.Cancelled, '已取消');
    labels.set(IssueState.Failed, t('state.failed'));
    labels.set(IssueState.Paused, t('state.paused'));
    labels.set(IssueState.ResolvingConflict, t('state.resolvingConflict'));
    return labels;
  }

  /**
   * 根据当前 state，推导每个 phase 的进度状态。
   * 支持通用状态 PhaseRunning/PhaseDone + currentPhase。
   */
  derivePhaseStatuses(currentState: string, currentPhase?: string): Record<string, 'pending' | 'in_progress' | 'completed' | 'failed'> {
    const result: Record<string, 'pending' | 'in_progress' | 'completed' | 'failed'> = {};
    let passedCurrent = false;

    // Failed 状态：基于 currentPhase 推导哪个阶段失败
    if (currentState === IssueState.Failed && currentPhase) {
      for (const phase of this.def.phases) {
        if (passedCurrent) {
          result[phase.name] = 'pending';
        } else if (phase.name === currentPhase) {
          result[phase.name] = 'failed';
          passedCurrent = true;
        } else {
          result[phase.name] = 'completed';
        }
      }
      return result;
    }

    // Paused 状态：暂停阶段显示为 in_progress，之前 completed，之后 pending
    if (currentState === IssueState.Paused && currentPhase) {
      for (const phase of this.def.phases) {
        if (passedCurrent) {
          result[phase.name] = 'pending';
        } else if (phase.name === currentPhase) {
          result[phase.name] = 'in_progress';
          passedCurrent = true;
        } else {
          result[phase.name] = 'completed';
        }
      }
      return result;
    }

    // 通用阶段状态：基于 currentPhase 名称推导
    if ((currentState === IssueState.PhaseRunning || currentState === IssueState.PhaseDone) && currentPhase) {
      for (const phase of this.def.phases) {
        if (passedCurrent) {
          result[phase.name] = 'pending';
        } else if (phase.name === currentPhase) {
          result[phase.name] = currentState === IssueState.PhaseRunning ? 'in_progress' : 'completed';
          passedCurrent = currentState === IssueState.PhaseRunning;
          // PhaseDone 意味着该阶段完成，后续为 pending
          if (currentState === IssueState.PhaseDone) passedCurrent = true;
        } else {
          result[phase.name] = 'completed';
        }
      }
      return result;
    }

    // 通用 gate 阶段状态：基于 currentPhase 名称推导
    if ((currentState === IssueState.PhaseWaiting || currentState === IssueState.PhaseApproved) && currentPhase) {
      for (const phase of this.def.phases) {
        if (passedCurrent) {
          result[phase.name] = 'pending';
        } else if (phase.name === currentPhase) {
          // AI phase with approvedState: PhaseApproved 意味着即将执行，显示 in_progress
          const isGatedAi = phase.kind === 'ai' && phase.approvedState;
          result[phase.name] = (currentState === IssueState.PhaseWaiting
            || (currentState === IssueState.PhaseApproved && isGatedAi))
            ? 'in_progress' : 'completed';
          passedCurrent = true;
        } else {
          result[phase.name] = 'completed';
        }
      }
      return result;
    }

    // 终态：所有阶段标记为 completed
    if (currentState === IssueState.Completed || currentState === IssueState.ResolvingConflict) {
      for (const phase of this.def.phases) {
        result[phase.name] = 'completed';
      }
      return result;
    }

    // 非通用阶段状态（传统 startState/doneState 匹配，如 BranchCreated 等）
    for (const phase of this.def.phases) {
      if (passedCurrent) {
        result[phase.name] = 'pending';
        continue;
      }
      if (phase.startState === currentState) {
        result[phase.name] = 'in_progress';
        passedCurrent = true;
      } else if (phase.doneState === currentState || phase.approvedState === currentState) {
        result[phase.name] = 'completed';
      } else {
        // 未匹配任何阶段的状态（Pending/Skipped/BranchCreated/Failed）→ pending
        result[phase.name] = 'pending';
      }
    }
    return result;
  }

  // ─── Pipeline Protocol queries (P1) ───

  /**
   * 返回可被用户单独重试的阶段名列表。
   * 优先使用 spec.retryable，未声明时默认 kind === 'ai'。
   */
  getRetryablePhases(): string[] {
    return this.def.phases
      .filter(spec => spec.retryable ?? (spec.kind === 'ai'))
      .map(spec => spec.name);
  }

  /**
   * 判断指定阶段是否可重试。
   */
  isRetryable(phaseName: string): boolean {
    const spec = this.def.phases.find(p => p.name === phaseName);
    if (!spec) return false;
    return spec.retryable ?? (spec.kind === 'ai');
  }

  /**
   * 查找 gate 类型的阶段。
   */
  getGatePhase(): PhaseSpec | undefined {
    return this.def.phases.find(p => p.kind === 'gate');
  }

  /**
   * 判断指定阶段完成后是否应启动预览服务器。
   */
  shouldDeployPreview(phaseName: string): boolean {
    const spec = this.def.phases.find(p => p.name === phaseName);
    return spec?.deploysPreview ?? false;
  }

  /**
   * 收集所有阶段的产物文件，扁平化为单一列表。
   */
  collectArtifacts(): PlanFileSpec[] {
    return this.def.phases.flatMap(spec => spec.artifacts ?? []);
  }

  /**
   * 返回所有阶段的名称和标签（保持定义顺序）。
   */
  getPhaseDefs(): { name: string; label: string }[] {
    return this.def.phases.map(p => ({ name: p.name, label: p.label }));
  }

  /**
   * 返回所有 kind === 'ai' 的阶段名（可执行阶段）。
   */
  getExecutablePhaseNames(): string[] {
    return this.def.phases
      .filter(spec => spec.kind === 'ai')
      .map(spec => spec.name);
  }
}
