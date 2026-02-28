/**
 * TaskFlowOrchestrator - Manages dialogue execution phase.
 *
 * This module handles:
 * - TaskFileWatcher for detecting new Task.md files
 * - ReflectionController execution (Evaluator → Executor → Reporter)
 * - Output adapters for Feishu integration
 * - Message tracking and cleanup
 * - Error handling
 *
 * Architecture (Serial Loop):
 * TaskFileWatcher loop: find task → execute (await) → wait (if no task)
 *
 * All tasks are processed serially, one at a time, to prevent:
 * - Resource contention (API quota exhaustion)
 * - Complex state tracking
 * - Debugging difficulties with interleaved logs
 *
 * Refactored (Issue #283): Uses ReflectionController instead of DialogueOrchestrator.
 * Refactored (Issue #413): Uses generic SkillAgent instead of specialized classes.
 */

import * as path from 'path';
import {
  ReflectionController,
  TerminationConditions,
  DialogueMessageTracker,
} from '../task/index.js';
import { TaskFileWatcher } from '../task/task-file-watcher.js';
import { Config } from '../config/index.js';
import { FeishuOutputAdapter } from '../utils/output-adapter.js';
import type { TaskTracker } from '../utils/task-tracker.js';
import { handleError, ErrorCategory } from '../utils/error-handler.js';
import type { Logger } from 'pino';
import type { AgentMessage } from '../types/agent.js';
import type { ReflectionContext } from '../task/reflection.js';
import { SkillAgent as SkillAgentImpl, type SkillContext } from '../agents/skill-agent.js';
import { TaskFileManager } from '../task/task-files.js';
import { DIALOGUE } from '../config/constants.js';

export interface MessageCallbacks {
  sendMessage: (chatId: string, text: string, parentMessageId?: string) => Promise<void>;
  sendCard: (chatId: string, card: Record<string, unknown>, description?: string, parentMessageId?: string) => Promise<void>;
  sendFile: (chatId: string, filePath: string) => Promise<void>;
}

export class TaskFlowOrchestrator {
  private messageCallbacks: MessageCallbacks;
  private logger: Logger;
  private fileWatcher: TaskFileWatcher;

  constructor(
    _taskTracker: TaskTracker,
    messageCallbacks: MessageCallbacks,
    logger: Logger
  ) {
    this.messageCallbacks = messageCallbacks;
    this.logger = logger;

    // Initialize file watcher with serial execution callback
    const workspaceDir = Config.getWorkspaceDir();
    const tasksDir = path.join(workspaceDir, 'tasks');

    this.fileWatcher = new TaskFileWatcher({
      tasksDir,
      onTaskCreated: (taskPath, messageId, chatId) => {
        // Serial execution: await is handled by TaskFileWatcher's main loop
        return this.executeDialoguePhase(chatId, messageId, taskPath);
      },
    });
  }

  /**
   * Start the file watcher.
   */
  async start(): Promise<void> {
    await this.fileWatcher.start();
    this.logger.info('TaskFlowOrchestrator started with file watcher (serial loop mode)');
  }

  /**
   * Stop the file watcher and cleanup.
   */
  stop(): void {
    this.fileWatcher.stop();
    this.logger.info('TaskFlowOrchestrator stopped');
  }

  /**
   * Execute dialogue phase for a task.
   *
   * This method is async and awaited by TaskFileWatcher to ensure
   * serial execution - only one task runs at a time.
   *
   * @param chatId - Feishu chat ID
   * @param messageId - Unique message identifier
   * @param taskPath - Path to the Task.md file
   */
  async executeDialoguePhase(
    chatId: string,
    messageId: string,
    taskPath: string
  ): Promise<void> {
    const agentConfig = Config.getAgentConfig();

    this.logger.info({ messageId, chatId }, 'Dialogue phase started (serial mode)');

    try {
      await this.runDialogue(chatId, messageId, taskPath, agentConfig);
    } catch (error) {
      this.logger.error({ err: error, chatId, messageId }, 'Dialogue failed');
      // Send error notification to user (as thread reply)
      await this.messageCallbacks.sendMessage(
        chatId,
        `❌ 任务执行失败: ${error instanceof Error ? error.message : String(error)}`,
        messageId
      ).catch((sendError) => {
        this.logger.error({ err: sendError }, 'Failed to send error notification');
      });
    }
  }

  /**
   * Run the dialogue phase using ReflectionController (Evaluator → Executor → Reporter).
   *
   * Refactored (Issue #283): Uses ReflectionController instead of DialogueOrchestrator.
   */
  private async runDialogue(
    chatId: string,
    messageId: string,
    taskPath: string,
    agentConfig: { apiKey: string; model: string; apiBaseUrl?: string }
  ): Promise<void> {
    // Import MCP tools to set message tracking callback
    const { setMessageSentCallback } = await import('../mcp/feishu-context-mcp.js');

    // Extract taskId from taskPath
    const taskDir = path.dirname(taskPath);
    const taskId = path.basename(taskDir);

    // Create message tracker
    const messageTracker = new DialogueMessageTracker();

    // Set the message sent callback to track when MCP tools send messages
    setMessageSentCallback((_chatId: string) => {
      messageTracker.recordMessageSent();
    });

    // Create output adapter for this chat
    // Pass messageId as parentMessageId for thread replies
    const adapter = new FeishuOutputAdapter({
      sendMessage: async (id: string, msg: string) => {
        messageTracker.recordMessageSent();
        await this.messageCallbacks.sendMessage(id, msg, messageId);
      },
      chatId,
    });
    adapter.clearThrottleState();
    adapter.resetMessageTracking();

    // Create file manager for checking final_result.md
    const fileManager = new TaskFileManager();

    let completionReason = 'unknown';

    // Create ReflectionController with termination conditions
    const controller = new ReflectionController(
      {
        maxIterations: DIALOGUE.MAX_ITERATIONS,
        confidenceThreshold: 0.8,
        enableMetrics: true,
      },
      [
        // Terminate when task is complete (final_result.md exists)
        (context: ReflectionContext) => {
          return fileManager.hasFinalResult(context.taskId);
        },
        // Terminate when max iterations reached
        TerminationConditions.maxIterations(DIALOGUE.MAX_ITERATIONS),
      ]
    );

    // Create execute phase: runs Evaluator (using SkillAgent)
    const executePhase = async function* (context: ReflectionContext): AsyncGenerator<AgentMessage> {
      const evaluator = new SkillAgentImpl({
        apiKey: agentConfig.apiKey,
        model: agentConfig.model,
        apiBaseUrl: agentConfig.apiBaseUrl,
        permissionMode: 'bypassPermissions',
        skillPath: 'evaluator/SKILL.md',
        allowedTools: ['Read', 'Grep', 'Glob', 'Write'],
      });

      // Build evaluation prompt
      const taskMdPath = fileManager.getTaskSpecPath(context.taskId);
      const evaluationPath = fileManager.getEvaluationPath(context.taskId, context.iteration);
      const previousExecutionPath = context.iteration > 1
        ? fileManager.getExecutionPath(context.taskId, context.iteration - 1)
        : null;

      let prompt = `# Evaluator Task

## Context
- Task ID: ${context.taskId}
- Iteration: ${context.iteration}

## Your Job

1. Read the task specification:
   \`${taskMdPath}\`
`;

      if (previousExecutionPath) {
        prompt += `
2. Read the previous execution output:
   \`${previousExecutionPath}\`
`;
      } else {
        prompt += `
2. This is the first iteration - no previous execution exists.
`;
      }

      prompt += `
3. Evaluate if the task is complete based on Expected Results

4. Write your evaluation to:
   \`${evaluationPath}\`

## Output Format for evaluation.md

\`\`\`markdown
# Evaluation: Iteration ${context.iteration}

## Status
[COMPLETE | NEED_EXECUTE]

## Assessment
(Your evaluation reasoning)

## Next Actions (only if NEED_EXECUTE)
- Action 1
- Action 2
\`\`\`

## Status Rules

### COMPLETE
When ALL conditions are met:
- ✅ All Expected Results satisfied
- ✅ Code actually modified (not just explained)
- ✅ Build passed (if required)
- ✅ Tests passed (if required)

### NEED_EXECUTE
When ANY condition is true:
- ❌ First iteration (no previous execution)
- ❌ Executor only explained (no code changes)
- ❌ Build failed or tests failed
- ❌ Expected Results not fully satisfied

## Important Notes

- Write the evaluation file to \`${evaluationPath}\`
- Do NOT output JSON - write markdown directly
- **When status=COMPLETE**: You MUST also create \`final_result.md\` to signal task completion

**If status is COMPLETE, also create final_result.md:**

Create this file: \`${fileManager.getFinalResultPath(context.taskId)}\`

\`\`\`markdown
# Final Result

Task completed successfully.

## Summary
(Brief summary of what was accomplished)

## Deliverables
- Deliverable 1
- Deliverable 2
\`\`\`

**Now start your evaluation.**`;

      const skillContext: SkillContext = {
        taskId: context.taskId,
        iteration: context.iteration,
      };

      try {
        yield* evaluator.executeWithContext(prompt, skillContext);
      } finally {
        evaluator.dispose();
      }
    };

    // Create evaluate phase: runs Executor (using SkillAgent)
    const evaluatePhase = async function* (context: ReflectionContext): AsyncGenerator<AgentMessage> {
      // Check if task is already complete
      const hasFinalResult = await fileManager.hasFinalResult(context.taskId);
      if (hasFinalResult) {
        yield {
          content: '✅ Task completed - final result detected',
          role: 'assistant',
          messageType: 'task_completion',
          metadata: { status: 'complete' },
        };
        return;
      }

      yield {
        content: '⚡ **Executing Task**',
        role: 'assistant',
        messageType: 'status',
      };

      const executor = new SkillAgentImpl({
        apiKey: agentConfig.apiKey,
        model: agentConfig.model,
        apiBaseUrl: agentConfig.apiBaseUrl,
        permissionMode: 'bypassPermissions',
        skillPath: 'executor/SKILL.md',
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
      });

      const reporter = new SkillAgentImpl({
        apiKey: agentConfig.apiKey,
        model: agentConfig.model,
        apiBaseUrl: agentConfig.apiBaseUrl,
        permissionMode: 'bypassPermissions',
        skillPath: 'reporter/SKILL.md',
        allowedTools: ['send_user_feedback', 'send_file_to_feishu'],
      });

      // Build executor prompt
      const taskMdPath = fileManager.getTaskSpecPath(context.taskId);
      const executionPath = fileManager.getExecutionPath(context.taskId, context.iteration);
      const evaluationPath = fileManager.getEvaluationPath(context.taskId, context.iteration);
      const workspaceDir = Config.getWorkspaceDir();

      const executorPrompt = `# Executor Task

## Context
- Task ID: ${context.taskId}
- Iteration: ${context.iteration}
- Workspace: ${workspaceDir}

## Your Job

1. Read the task specification: \`${taskMdPath}\`
2. Read the evaluation guidance: \`${evaluationPath}\`
3. Execute the task:
   - Make code changes
   - Run tests if required
   - Verify expected results
4. Create execution.md: \`${executionPath}\`

## Output File

Create \`${executionPath}\` with this format:

\`\`\`markdown
# Execution: Iteration ${context.iteration}

**Timestamp**: {ISO timestamp}
**Status**: Completed

## Summary
(Brief description of what you did)

## Changes Made
- Change 1
- Change 2

## Files Modified
- file1.ts
- file2.ts

## Expected Results Satisfied
✅ Requirement 1
   - Verification: How you verified it
\`\`\`

**Now start executing the task.**`;

      const skillContext: SkillContext = {
        taskId: context.taskId,
        iteration: context.iteration,
        chatId,
      };

      try {
        // Execute task
        for await (const msg of executor.executeWithContext(executorPrompt, skillContext)) {
          yield msg;
        }

        // Send completion report
        const reporterPrompt = `# Reporter Task

## Context
- Task ID: ${context.taskId}
- Iteration: ${context.iteration}
- Chat ID: ${chatId}

## Your Job

1. Check for any report files in the task directory
2. Send report files using send_file_to_feishu
3. Send completion feedback using send_user_feedback

**Chat ID for Feishu tools**: \`${chatId}\`

**Now check for and send any report files.**`;

        for await (const msg of reporter.executeWithContext(reporterPrompt, skillContext)) {
          yield msg;
        }
      } catch (error) {
        yield {
          content: `❌ **Task execution failed**: ${error instanceof Error ? error.message : String(error)}`,
          role: 'assistant',
          messageType: 'error',
        };
      } finally {
        executor.dispose();
        reporter.dispose();
      }
    };

    try {
      this.logger.debug({ chatId, taskId }, 'Starting dialogue with ReflectionController');

      // Run reflection cycle
      for await (const message of controller.run(taskId, executePhase, evaluatePhase)) {
        const content = typeof message.content === 'string'
          ? message.content
          : '';

        if (!content) {
          continue;
        }

        // Send to user
        await adapter.write(content, message.messageType ?? 'text', {
          toolName: message.metadata?.toolName as string | undefined,
          toolInputRaw: message.metadata?.toolInputRaw as Record<string, unknown> | undefined,
        });

        // Update completion reason based on message type
        if (message.messageType === 'result') {
          completionReason = 'task_done';
        } else if (message.messageType === 'error') {
          completionReason = 'error';
        } else if (message.messageType === 'task_completion') {
          completionReason = 'task_done';
        }
      }

      // Check final result
      const hasFinalResult = await fileManager.hasFinalResult(taskId);
      if (hasFinalResult) {
        completionReason = 'task_done';
      }
    } catch (error) {
      this.logger.error({ err: error, chatId }, 'Task flow failed');
      completionReason = 'error';

      const enriched = handleError(error, {
        category: ErrorCategory.SDK,
        chatId,
        userMessage: 'Task processing failed. Please try again.'
      }, {
        log: true,
        customLogger: this.logger
      });

      const errorMsg = `❌ ${enriched.userMessage || enriched.message}`;
      await this.messageCallbacks.sendMessage(chatId, errorMsg, messageId);
    } finally {
      // Clean up message tracking callback to prevent memory leaks
      setMessageSentCallback(null);

      // Check if no user message was sent and send warning
      if (!messageTracker.hasAnyMessage()) {
        const warning = messageTracker.buildWarning(completionReason, taskId);
        this.logger.info({ chatId, completionReason }, 'Sending no-message warning to user');
        await this.messageCallbacks.sendMessage(chatId, warning, messageId);
      }
    }
  }
}
