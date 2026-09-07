import { GitOperations } from './GitOperations.js';
import type { AIRunner } from '../ai-runner/index.js';
import { conflictResolvePrompt } from '../prompts/templates.js';
import { logger as rootLogger } from '../logger.js';

const logger = rootLogger.child('ConflictResolver');

export interface ConflictResolveOptions {
  wtGit: GitOperations;
  targetRef: string;
  workDir: string;
  branchName: string;
  /** Identifier for logging and events (e.g. issueIid or taskId) */
  contextId: string | number;
  maxAttempts?: number;
  phaseTimeoutMs: number;
  onEvent?: (event: unknown) => void;
}

/** 当前单仓工作台的持久化与执行上下文。 */
export class ConflictResolver {
  constructor(private aiRunner: AIRunner) {}

  /**
   * Rebase the current branch onto `targetRef` and resolve any conflicts using AI.
   * After successful resolution, the caller is responsible for force-pushing.
   *
   * @throws if conflicts cannot be resolved within maxAttempts
   */
  async resolve(opts: ConflictResolveOptions): Promise<void> {
    const { wtGit, targetRef, workDir, branchName, contextId, phaseTimeoutMs, onEvent } = opts;
    const maxAttempts = opts.maxAttempts ?? 20;

    // Abort residual rebase if any
    if (await wtGit.isRebaseInProgress()) {
      logger.warn('Found residual rebase in progress, aborting', { contextId });
      await wtGit.rebaseAbort();
    }

    // Attempt rebase
    const rebaseResult = await wtGit.rebase(targetRef);

    if (rebaseResult.success) {
      logger.info('Rebase succeeded without conflicts', { contextId });
      return;
    }

    // Has conflicts — resolve with AI
    let conflictFiles = rebaseResult.conflictFiles;
    let attempt = 0;

    while (conflictFiles.length > 0 && attempt < maxAttempts) {
      attempt++;
      logger.info('Resolving conflicts with AI', { contextId, attempt, conflictFiles });

      const prompt = conflictResolvePrompt({
        issueIid: typeof contextId === 'number' ? contextId : 0,
        branchName,
        baseBranch: targetRef.replace(/^origin\//, ''),
        conflictFiles,
      });

      await this.aiRunner.run({
        prompt,
        workDir,
        timeoutMs: phaseTimeoutMs,
        onStreamEvent: onEvent ? (event: unknown) => onEvent(event) : undefined,
      });

      // Stage resolved files
      await wtGit.add(conflictFiles);

      // Continue rebase
      const continueResult = await wtGit.rebaseContinue();
      if (continueResult.done) {
        conflictFiles = [];
      } else {
        conflictFiles = continueResult.conflictFiles;
      }
    }

    if (conflictFiles.length > 0) {
      await wtGit.rebaseAbort();
      throw new Error(
        `Failed to resolve all conflicts after ${maxAttempts} attempts. Remaining: ${conflictFiles.join(', ')}`,
      );
    }

    logger.info('All conflicts resolved', { contextId, totalAttempts: attempt });
  }
}
