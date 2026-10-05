type Translate = (key: string, params?: Record<string, string | number>) => string;

/** 前后端共用生命周期文案规则，各自保留语言与阶段名称来源。 */
export function formatLifecycleLabel(
  lifecycle: { kind: string; phase?: string },
  translate: Translate,
  phasePrefix = 'phase',
): string {
  if (lifecycle.kind === 'running' || lifecycle.kind === 'waiting') {
    const label = translate(`${phasePrefix}.${lifecycle.phase}`);
    return translate(lifecycle.kind === 'running' ? 'state.phaseDoing' : 'state.phaseWaiting', { label });
  }
  return translate(`state.${lifecycle.kind}`);
}
