import { BasePhase, PhaseContext } from './BasePhase.js';
import { buildPrompt, demandToPromptContext } from '../prompts/templates.js';
import { AIExecutionError } from '../errors/index.js';
import { t } from '../i18n/index.js';

export class BuildPhase extends BasePhase {
  readonly phaseName = 'build' as const;

  protected async validatePhaseOutput(): Promise<void> {
    if (!(await this.git.hasChanges())) {
      const msg = 'AI 进程成功退出但未产生任何代码变更';
      this.logger.error(msg, { phase: this.phaseName });
      throw new AIExecutionError(this.phaseName, msg, { output: '', exitCode: 0 });
    }
  }

  protected buildPrompt(ctx: PhaseContext): string {
    const pc = demandToPromptContext(ctx.demand);
    const base = buildPrompt({
      issueTitle: pc.title,
      issueDescription: pc.description,
      issueIid: Number(pc.displayId),
      workspace: ctx.workspace,
    });

    if (ctx.fixContext) {
      return base + t('prompt.buildFixSuffix', {
        iteration: ctx.fixContext.iteration,
        failures: ctx.fixContext.verifyFailures.map((f, i) => `${i + 1}. ${f}`).join('\n'),
        rawReport: ctx.fixContext.rawReport.slice(0, 2000),
      });
    }

    return base;
  }
}
