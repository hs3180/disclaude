/**
 * Executor - runs individual subtasks with isolated agents.
 *
 * Refactored to yield progress events instead of handling reporting directly.
 * The IterationBridge layer connects these events to the Reporter for user communication.
 *
 * Now follows Scout's architecture:
 * - Uses Config.getAgentConfig() for unified configuration
 * - Uses createLogger() for structured logging
 * - Uses buildExecutorPrompt() from prompt-builder
 * - Supports skill activation via /skill:executor command
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createAgentSdkOptions, parseSDKMessage } from '../utils/sdk.js';
import type { Subtask, SubtaskResult, LongTaskConfig } from '../long-task/types.js';
import type { ParsedSDKMessage } from '../types/agent.js';
import { TaskFileManager } from '../task/file-manager.js';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { buildExecutorPrompt, buildContextInfo } from '../long-task/executor-prompt-builder.js';

/**
 * Executor configuration.
 *
 * Follows Scout's pattern with optional skillName and uses Config for API credentials.
 */
export interface ExecutorConfig {
  /**
   * Name of the skill to use.
   * Defaults to 'executor' if not provided.
   */
  skillName?: string;
  /**
   * Abort signal for cancellation.
   */
  abortSignal?: AbortSignal;
  /**
   * Total number of steps in the task (for progress reporting).
   */
  totalSteps?: number;
}

/**
 * Progress event type for subtask execution.
 * These events are yielded during execution and passed to the Reporter by the IterationBridge.
 */
export type SubtaskProgressEvent =
  | {
      type: 'start';
      sequence: number;
      totalSteps: number;
      title: string;
      description: string;
    }
  | {
      type: 'output';
      content: string;
      messageType: string;
      metadata?: ParsedSDKMessage['metadata'];
    }
  | {
      type: 'complete';
      sequence: number;
      title: string;
      files: string[];
      summaryFile: string;
    }
  | {
      type: 'error';
      sequence: number;
      title: string;
      error: string;
    };

/**
 * Executor for running individual subtasks.
 *
 * Yields progress events during execution without handling user communication.
 * All reporting is delegated to the Reporter via the IterationBridge layer.
 *
 * Now follows Scout's architecture:
 * - Uses Config for unified agent configuration
 * - Uses createLogger for structured logging
 * - Supports skill activation
 */
export class Executor {
  private readonly skillName: string;
  private readonly config: LongTaskConfig;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly apiBaseUrl?: string;
  private fileManager: TaskFileManager;
  private logger: ReturnType<typeof createLogger>;

  constructor(config: ExecutorConfig & LongTaskConfig) {
    // Get agent configuration from Config (like Scout)
    const agentConfig = Config.getAgentConfig();

    this.skillName = config.skillName || 'executor';
    this.apiKey = agentConfig.apiKey;
    this.model = agentConfig.model;
    this.apiBaseUrl = agentConfig.apiBaseUrl;
    this.config = config;

    // Create logger with model information (like Scout)
    this.logger = createLogger('Executor', { model: this.model });
    this.fileManager = new TaskFileManager();

    this.logger.debug({
      skillName: this.skillName,
      provider: agentConfig.provider,
      model: this.model,
      totalSteps: config.totalSteps,
    }, 'Executor initialized');
  }

  /**
   * Execute a single subtask with a fresh agent.
   *
   * Yields progress events during execution:
   * - 'start': When the subtask begins
   * - 'output': For each message from the agent
   * - 'complete': When the subtask succeeds
   * - 'error': When the subtask fails
   *
   * Returns the final SubtaskResult when complete.
   */
  async *executeSubtask(
    subtask: Subtask,
    previousResults: SubtaskResult[],
    workspaceDir: string,
    taskId?: string,
    iteration?: number
  ): AsyncGenerator<SubtaskProgressEvent, SubtaskResult> {
    const subtaskDir = path.join(workspaceDir, `subtask-${subtask.sequence}`);

    // Check for cancellation before starting
    if (this.config.abortSignal?.aborted) {
      throw new Error('AbortError');
    }

    await fs.mkdir(subtaskDir, { recursive: true });

    // ✨ NEW: Detailed logging (like Scout)
    this.logger.debug({
      subtaskSequence: subtask.sequence,
      subtaskTitle: subtask.title,
      workspaceDir: subtaskDir,
      taskId,
      iteration,
      previousResultsCount: previousResults.length,
    }, 'Starting subtask execution');

    // Prepare context from previous results using prompt builder
    const contextInfo = buildContextInfo(previousResults);

    // Create execution prompt using prompt builder (like Scout's buildScoutPrompt)
    const prompt = this.buildFullPrompt(subtask, contextInfo, subtaskDir);

    // Create SDK options using shared utility (like Scout's createSdkOptions)
    const sdkOptions = this.createSdkOptions(subtaskDir);

    // ✨ NEW: Log prompt and SDK config (like Scout)
    this.logger.debug({
      promptLength: prompt.length,
      promptPreview: prompt.substring(0, 500),
      model: (sdkOptions as { model?: string }).model,
      allowedTools: (sdkOptions as { allowedTools?: string[] }).allowedTools,
      hasEnv: !!(sdkOptions as { env?: Record<string, unknown> }).env,
    }, 'Executor SDK query config');

    const startTime = Date.now();

    try {
      // Yield start event (reporting layer will format and send to user)
      yield {
        type: 'start',
        sequence: subtask.sequence,
        totalSteps: this.config.totalSteps ?? 0,
        title: subtask.title,
        description: subtask.description,
      };

      // Execute subtask with fresh agent
      const queryResult = query({
        prompt,
        options: sdkOptions,
      });

      // Collect response and track created files
      let fullResponse = '';
      const createdFiles: string[] = [];

      // Track abort state
      let aborted = false;

      // Add abort listener (set flag instead of throwing)
      const abortHandler = () => {
        console.log(`[Executor] Subtask ${subtask.sequence} aborted`);
        aborted = true;
      };

      if (this.config.abortSignal) {
        this.config.abortSignal.addEventListener('abort', abortHandler, { once: true });
      }

      try {
        for await (const message of queryResult) {
          // Check for abort (from handler or signal state)
          if (aborted || this.config.abortSignal?.aborted) {
            throw new Error('AbortError');
          }
          // Check for cancellation during iteration
          if (this.config.abortSignal?.aborted) {
            throw new Error('AbortError');
          }

          const parsed = parseSDKMessage(message);

          if (parsed.content) {
            fullResponse += parsed.content;
          }

          // ✨ NEW: Tool use tracking (like Scout)
          if (parsed.type === 'tool_use' && parsed.metadata?.toolName) {
            const toolName = parsed.metadata.toolName;

            // Track Write/Edit operations
            if (toolName === 'Write' || toolName === 'Edit') {
              try {
                const toolInputRaw = parsed.metadata.toolInputRaw as Record<string, unknown> | undefined;

                if (toolInputRaw) {
                  // Extract file path from tool input
                  const filePath = (toolInputRaw.file_path as string | undefined) ||
                                  (toolInputRaw.filePath as string | undefined);

                  if (filePath) {
                    this.logger.debug({
                      toolName,
                      filePath,
                      contentLength: (toolInputRaw.content as string | undefined)?.length || 0,
                    }, 'File operation detected');

                    // Add to created files list
                    if (!createdFiles.includes(filePath)) {
                      createdFiles.push(filePath);
                    }
                  }
                }
              } catch (error) {
                this.logger.error({ err: error }, 'Failed to parse tool input');
              }
            }

            // Track other tool usage for logging
            this.logger.debug({
              toolName,
              toolInput: parsed.metadata.toolInput,
            }, 'Tool use detected');
          }

          // Yield output event (reporting layer will format and send to user)
          yield {
            type: 'output',
            content: parsed.content,
            messageType: parsed.type,
            metadata: parsed.metadata,
          };
        }
      } finally {
        // Remove abort listener
        if (this.config.abortSignal) {
          this.config.abortSignal.removeEventListener('abort', abortHandler);
        }
      }

      // Ensure summary file exists
      // If summaryFile is not specified in plan, use default: summary.md
      const summaryFileName = subtask.outputs.summaryFile || 'summary.md';
      const summaryFile = path.join(subtaskDir, summaryFileName);

      // Check if summary file was created
      try {
        await fs.access(summaryFile);
      } catch {
        // Create default summary if agent didn't create one
        const defaultSummary = this.createDefaultSummary(subtask, fullResponse, createdFiles);
        await fs.writeFile(summaryFile, defaultSummary, 'utf-8');
      }

      // List all files created in subtask directory
      const files = await this.listCreatedFiles(subtaskDir);

      const duration = Date.now() - startTime;

      console.log(`[Executor] Completed subtask ${subtask.sequence} in ${duration}ms`);

      // ✨ NEW: Write step result via TaskFileManager
      if (taskId && iteration) {
        try {
          const stepContent = this.formatStepMarkdown(subtask, fullResponse, files, duration, true);
          await this.fileManager.writeStepResult(taskId, iteration, subtask.sequence, stepContent);
        } catch (error) {
          console.error(`[Executor] Failed to write step result via TaskFileManager:`, error);
        }
      }

      // Yield completion event (reporting layer will format and send to user)
      yield {
        type: 'complete',
        sequence: subtask.sequence,
        title: subtask.title,
        files,
        summaryFile,
      };

      return {
        sequence: subtask.sequence,
        success: true,
        summary: fullResponse,
        files,
        summaryFile,
        completedAt: new Date().toISOString(),
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      // ✨ NEW: Detailed error logging (like Scout)
      this.logger.error({
        err: error,
        subtaskSequence: subtask.sequence,
        subtaskTitle: subtask.title,
        duration,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      }, 'Subtask execution failed');

      // ✨ NEW: Improved error classification and handling
      if (error instanceof Error) {
        // Abort error - re-raise without sending message
        if (error.message === 'AbortError' || error.name === 'AbortError') {
          this.logger.debug({ subtaskSequence: subtask.sequence }, 'Subtask aborted');
          throw error;
        }

        // API errors - provide user-friendly message
        if (error.message.includes('API') || error.message.includes('rate limit') || error.message.includes('quota')) {
          const friendlyMessage = `API Error: ${error.message}. Please try again or check your API quota.`;

          yield {
            type: 'error',
            sequence: subtask.sequence,
            title: subtask.title,
            error: friendlyMessage,
          };

          return {
            sequence: subtask.sequence,
            success: false,
            summary: '',
            files: [],
            summaryFile: path.join(subtaskDir, subtask.outputs.summaryFile || 'summary.md'),
            error: friendlyMessage,
            completedAt: new Date().toISOString(),
          };
        }

        // Network errors
        if (error.message.includes('ECONN') || error.message.includes('network') || error.message.includes('timeout')) {
          const friendlyMessage = `Network Error: ${error.message}. Please check your connection and try again.`;

          yield {
            type: 'error',
            sequence: subtask.sequence,
            title: subtask.title,
            error: friendlyMessage,
          };

          return {
            sequence: subtask.sequence,
            success: false,
            summary: '',
            files: [],
            summaryFile: path.join(subtaskDir, subtask.outputs.summaryFile || 'summary.md'),
            error: friendlyMessage,
            completedAt: new Date().toISOString(),
          };
        }

        // Generic error - use original message
        yield {
          type: 'error',
          sequence: subtask.sequence,
          title: subtask.title,
          error: error.message,
        };

        return {
          sequence: subtask.sequence,
          success: false,
          summary: '',
          files: [],
          summaryFile: path.join(subtaskDir, subtask.outputs.summaryFile || 'summary.md'),
          error: error.message,
          completedAt: new Date().toISOString(),
        };
      }

      // Non-Error errors (string, number, etc.)
      const errorString = String(error);
      yield {
        type: 'error',
        sequence: subtask.sequence,
        title: subtask.title,
        error: errorString,
      };

      return {
        sequence: subtask.sequence,
        success: false,
        summary: '',
        files: [],
        summaryFile: path.join(subtaskDir, subtask.outputs.summaryFile || 'summary.md'),
        error: errorString,
        completedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Create SDK options for Executor agent (like Scout's createSdkOptions).
   *
   * Uses unified configuration from Config and buildSdkEnv.
   */
  private createSdkOptions(workingDir: string): Record<string, unknown> {
    const sdkOptions = createAgentSdkOptions({
      apiKey: this.apiKey,
      model: this.model,
      apiBaseUrl: this.apiBaseUrl,
      cwd: workingDir,
      permissionMode: 'bypassPermissions',
    });

    // Add executor-specific logging
    this.logger.debug({
      skillName: this.skillName,
      workingDirectory: workingDir,
      model: this.model,
    }, 'Executor SDK options');

    return sdkOptions;
  }

  /**
   * Build full prompt with skill activation command (like Scout's buildFullPrompt).
   *
   * The prompt structure is:
   * 1. Skill activation command (uses SDK's Skill tool)
   * 2. Task context from prompt builder
   *
   * @param subtask - Subtask to execute
   * @param contextInfo - Context from previous steps
   * @param workspaceDir - Working directory for this subtask
   * @returns Full prompt with skill activation
   */
  private buildFullPrompt(subtask: Subtask, contextInfo: string, workspaceDir: string): string {
    const parts: string[] = [];

    // 1. Skill activation command - tells SDK to load and use the skill (like Scout)
    parts.push(`/skill:${this.skillName}`);

    // 2. Use prompt builder to create the execution prompt (like buildScoutPrompt)
    const executionPrompt = buildExecutorPrompt({
      subtask,
      contextInfo,
      workspaceDir,
    });

    parts.push(executionPrompt);

    return parts.join('\n\n');
  }

  /**
   * Create default summary if agent doesn't provide one.
   */
  private createDefaultSummary(subtask: Subtask, response: string, files: string[]): string {
    const date = new Date().toISOString();

    return `# Summary: ${subtask.title}

**Subtask Sequence**: ${subtask.sequence}
**Completed At**: ${date}

## What Was Done

${subtask.description}

## Agent Response

\`\`\`
${response.substring(0, 2000)}${response.length > 2000 ? '\n... (truncated)' : ''}
\`\`\`

## Files Created

${files.length > 0 ? files.map(f => `- \`${f}\``).join('\n') : 'No files were tracked.'}

## Notes

This summary was automatically generated. The agent should have created a more detailed summary.
`;
  }

  /**
   * Format step result as markdown.
   */
  private formatStepMarkdown(subtask: Subtask, output: string, files: string[], duration: number, success: boolean): string {
    const timestamp = new Date().toISOString();

    return `# Step Result: ${subtask.title}

**Step Number**: ${subtask.sequence}
**Timestamp**: ${timestamp}
**Agent**: ${this.model}
**Duration**: ${duration}ms

## Status

${success ? '✅ Success' : '❌ Failed'}

## Output

${output}

## Files Created

${files.length > 0 ? files.map(f => `- \`${f}\``).join('\n') : '(No files created)'}

## Key Findings

${success ? 'Step completed successfully.' : 'Step failed - see error details above.'}
`;
  }

  /**
   * List all files created in the subtask directory.
   */
  private async listCreatedFiles(subtaskDir: string): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await fs.readdir(subtaskDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isFile()) {
          files.push(entry.name);
        } else if (entry.isDirectory()) {
          // Recursively list subdirectories
          const subPath = path.join(subtaskDir, entry.name);
          const subFiles = await this.listCreatedFiles(subPath);
          files.push(...subFiles.map(f => path.join(entry.name, f)));
        }
      }
    } catch (error) {
      console.error(`[Executor] Failed to list files in ${subtaskDir}:`, error);
    }

    return files;
  }
}
