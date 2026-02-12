/**
 * Executor - Executes tasks directly with a fresh agent.
 *
 * Simplified architecture:
 * - No subtask concept
 * - Direct task execution based on Evaluator feedback
 * - Yields progress events for real-time reporting
 * - Uses Config for unified configuration
 */
import * as fs from 'fs/promises';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createAgentSdkOptions, parseSDKMessage } from '../utils/sdk.js';
import type { ParsedSDKMessage } from '../types/agent.js';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { AgentExecutionError, TimeoutError, formatError } from '../utils/errors.js';

/**
 * Executor configuration.
 */
export interface ExecutorConfig {
  /**
   * Abort signal for cancellation.
   */
  abortSignal?: AbortSignal;
}

/**
 * Progress event type for task execution.
 * These events are yielded during execution and passed to the Reporter.
 */
export type TaskProgressEvent =
  | {
      type: 'start';
      title: string;
    }
  | {
      type: 'output';
      content: string;
      messageType: string;
      metadata?: ParsedSDKMessage['metadata'];
    }
  | {
      type: 'complete';
      summaryFile: string;
      files: string[];
    }
  | {
      type: 'error';
      error: string;
    };

/**
 * Result of task execution.
 */
export interface TaskResult {
  success: boolean;
  summaryFile: string;
  files: string[];
  output: string;
  error?: string;
}

/**
 * Executor for running tasks directly.
 *
 * Yields progress events during execution without handling user communication.
 * All reporting is delegated to the Reporter via the IterationBridge layer.
 */
export class Executor {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly apiBaseUrl?: string;
  private readonly provider: 'anthropic' | 'glm';
  private logger: ReturnType<typeof createLogger>;
  private readonly config: ExecutorConfig;

  constructor(config: ExecutorConfig) {
    this.config = config;

    // Get agent configuration from Config
    const agentConfig = Config.getAgentConfig();

    this.apiKey = agentConfig.apiKey;
    this.model = agentConfig.model;
    this.apiBaseUrl = agentConfig.apiBaseUrl;
    this.provider = agentConfig.provider;

    // Create logger
    this.logger = createLogger('Executor', { model: this.model });

    this.logger.debug({
      provider: agentConfig.provider,
      model: this.model,
    }, 'Executor initialized');
  }

  /**
   * Execute a task with a fresh agent.
   *
   * Yields progress events during execution:
   * - 'start': When the task begins
   * - 'output': For each message from the agent
   * - 'complete': When the task succeeds
   * - 'error': When the task fails
   *
   * Returns the final TaskResult when complete.
   */
  async *executeTask(
    taskInstructions: string,
    workspaceDir: string,
    taskId?: string,
    iteration?: number,
    previousOutput?: string
  ): AsyncGenerator<TaskProgressEvent, TaskResult> {
    // Check for cancellation
    if (this.config?.abortSignal?.aborted) {
      throw new Error('AbortError');
    }

    await fs.mkdir(workspaceDir, { recursive: true });

    // Yield start event
    yield {
      type: 'start',
      title: 'Execute Task',
    };

    // Build the task execution prompt
    const prompt = this.buildTaskPrompt(taskInstructions, previousOutput);

    // Log execution start
    this.logger.debug({
      workspaceDir,
      taskId,
      iteration,
      promptLength: prompt.length,
      previousOutputLength: previousOutput?.length || 0,
    }, 'Starting task execution');

    // Prepare SDK options
    const sdkOptions = createAgentSdkOptions({
      apiKey: this.apiKey,
      model: this.model,
      apiBaseUrl: this.apiBaseUrl,
      permissionMode: 'bypassPermissions',
      cwd: workspaceDir,
    });

    let output = '';
    let error: string | undefined;

    // Get task timeout from Config (default: 5 minutes)
    const ITERATOR_TIMEOUT_MS = Config.getTaskTimeout();

    this.logger.debug({
      timeoutMs: ITERATOR_TIMEOUT_MS,
      timeoutMinutes: Math.round(ITERATOR_TIMEOUT_MS / 60000),
    }, 'Executor timeout configured');

    try {
      // Execute task with agent
      const generator = query({ prompt, options: sdkOptions });
      const iterator = generator[Symbol.asyncIterator]();

      while (true) {
        // Race between next message and timeout
        const nextPromise = iterator.next();
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Iterator timeout')), ITERATOR_TIMEOUT_MS)
        );

        const result = await Promise.race([nextPromise, timeoutPromise]) as IteratorResult<unknown>;

        if (result.done) {
          break;
        }

        const message = result.value as SDKMessage;
        const parsed = parseSDKMessage(message);

        // GLM-specific logging to monitor streaming behavior
        if (this.provider === 'glm') {
          this.logger.debug({
            provider: 'GLM',
            messageType: parsed.type,
            contentLength: parsed.content?.length || 0,
            toolName: parsed.metadata?.toolName,
            stopReason: (message as any).stop_reason,
            stopSequence: (message as any).stop_sequence,
            rawMessagePreview: JSON.stringify(message).substring(0, 500),
          }, 'SDK message received (GLM)');
        }

        // Collect all content-producing messages
        if (['text', 'tool_use', 'tool_progress', 'tool_result', 'status', 'result'].includes(parsed.type)) {
          output += parsed.content;

          // Yield output event
          yield {
            type: 'output',
            content: parsed.content,
            messageType: parsed.type,
            metadata: parsed.metadata,
          };

          // Log with full content (as per logging guidelines)
          this.logger.debug({
            content: parsed.content,
            contentLength: parsed.content.length,
            messageType: parsed.type,
          }, 'Executor output');
        } else if (parsed.type === 'error') {
          error = parsed.content; // Error message is in content
          this.logger.error({ error: parsed.content }, 'Executor error');
        }
      }

      // Create summary file
      const summaryFile = await this.createSummary(workspaceDir, taskInstructions, output, error);

      // Find all created files
      const files = await this.findCreatedFiles(workspaceDir);

      // Yield complete event
      yield {
        type: 'complete',
        summaryFile,
        files,
      };

      // Return result
      return {
        success: !error,
        summaryFile,
        files,
        output,
        error,
      };

    } catch (err) {
      const isTimeout = err instanceof Error && err.message === 'Iterator timeout';
      error = err instanceof Error ? err.message : String(err);

      if (isTimeout) {
        const timeoutError = new TimeoutError(
          'Task execution timeout - operation took longer than expected',
          ITERATOR_TIMEOUT_MS,
          'executeTask'
        );
        this.logger.warn({ err: formatError(timeoutError) }, 'Executor iterator timeout - task may be incomplete');
        error = timeoutError.message;
      } else {
        const agentError = new AgentExecutionError(
          'Task execution failed',
          {
            cause: err instanceof Error ? err : new Error(String(err)),
            agent: 'Executor',
            recoverable: true,
          }
        );
        this.logger.error({ err: formatError(agentError) }, 'Task execution failed');
      }

      yield {
        type: 'error',
        error,
      };

      return {
        success: false,
        summaryFile: '',
        files: [],
        output,
        error,
      };
    }
  }

  /**
   * Build task execution prompt.
   */
  private buildTaskPrompt(taskInstructions: string, previousOutput?: string): string {
    const parts: string[] = [];

    parts.push('# Task Execution');
    parts.push('');
    parts.push('You are executing a task. Carefully read the instructions and complete the work.');
    parts.push('');

    if (previousOutput) {
      parts.push('## Previous Work');
      parts.push('');
      parts.push('In the previous iteration, the following was accomplished:');
      parts.push('');
      parts.push(previousOutput);
      parts.push('');
      parts.push('---');
      parts.push('');
    }

    parts.push('## Task Instructions');
    parts.push('');
    parts.push(taskInstructions);
    parts.push('');
    parts.push('---');
    parts.push('');
    parts.push('**Start executing the task now.**');
    parts.push('');
    parts.push('**Remember to create a summary.md file documenting your work when you complete.**');

    return parts.join('\n');
  }

  /**
   * Create summary file in workspace.
   */
  private async createSummary(
    workspaceDir: string,
    taskInstructions: string,
    output: string,
    error?: string
  ): Promise<string> {
    const summaryPath = `${workspaceDir}/summary.md`;
    const timestamp = new Date().toISOString();

    const summary = `# Task Execution Summary

**Timestamp**: ${timestamp}
**Status**: ${error ? 'Failed' : 'Completed'}

## Task Instructions

${taskInstructions}

## Execution Output

${output}

${error ? `## Error\n\n${error}\n` : ''}

## Files Created

See task directory for created files.
`;

    await fs.writeFile(summaryPath, summary, 'utf-8');
    this.logger.debug({ summaryPath }, 'Summary file created');

    return summaryPath;
  }

  /**
   * Find all files created in workspace (excluding summary.md).
   */
  private async findCreatedFiles(workspaceDir: string): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await fs.readdir(workspaceDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isFile() && entry.name !== 'summary.md') {
          files.push(entry.name);
        }
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to list workspace files');
    }

    return files;
  }
}
