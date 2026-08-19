import type { DriftConfig } from '../config/schema.js';
import type { RepoContext } from '../types.js';
import { dispatchToCopilot, getTaskStatus, isTerminalState } from '../dispatch/copilot.js';
import type { Logger } from '../util/logger.js';
import type { AgentAvailability, AgentContext, CloudAgentTaskRef, CloudFixAgent, FixOutcome, FixTask } from './types.js';

export interface CopilotCloudAgentOptions {
  repo: RepoContext;
  config: DriftConfig;
  token?: string;
  logger: Logger;
  dryRun?: boolean;
}

export class CopilotCloudAgent implements CloudFixAgent {
  readonly id = 'copilot-cloud';
  readonly label = 'Copilot Cloud';
  readonly description = 'Runs on GitHub through the Copilot coding-agent API.';
  readonly kind = 'cloud' as const;
  readonly capabilities = {
    execution: 'cloud',
    canAwaitCompletion: true,
    canInspectResult: false,
  } as const;

  constructor(private readonly options: CopilotCloudAgentOptions) {}

  async detect(): Promise<AgentAvailability> {
    if (!this.options.token) {
      return {
        available: false,
        reason:
          'No Copilot cloud token is available. Pass the generic agent credentials for copilot-cloud or the legacy copilot-token compatibility input.',
      };
    }
    return { available: true, detail: `${this.options.repo.owner}/${this.options.repo.repo}` };
  }

  async run(task: FixTask, _ctx: AgentContext): Promise<FixOutcome> {
    const result = await dispatchToCopilot({
      copilotToken: this.options.token ?? '',
      repo: this.options.repo,
      plan: task.plan,
      config: {
        ...this.options.config,
        remediation: {
          ...this.options.config.remediation,
          model: task.model ?? this.options.config.remediation.model,
        },
      },
      logger: this.options.logger,
      dryRun: this.options.dryRun,
    });

    if (!result.ok) {
      return { status: 'failed', message: result.error ?? 'Copilot cloud dispatch failed.' };
    }

    const taskId = result.task?.id ?? 'unknown';
    const url = result.task?.pullRequestUrl;
    return {
      status: 'delegated',
      url,
      message: url
        ? `Copilot cloud is working on ${task.plan.commits.length} commit(s): ${url}`
        : `Copilot cloud task ${taskId} started (${result.task?.state ?? 'queued'}).`,
      handle: {
        provider: this.id,
        id: taskId,
        state: result.task?.state ?? 'queued',
        branch: task.plan.branchName,
        ...(url ? { url } : {}),
        capabilities: this.capabilities,
      },
    };
  }

  async status(task: CloudAgentTaskRef) {
    return getTaskStatus({ copilotToken: this.options.token ?? '', repo: this.options.repo, taskId: task.id });
  }

  isTerminalState(state: string): boolean {
    return isTerminalState(state);
  }
}
