/**
 * Reporter - Communication and instruction generation specialist.
 *
 * **Single Responsibility**: Generate Executor instructions and format user feedback.
 *
 * **Key Differences from Manager:**
 * - Manager: Evaluates AND generates instructions AND formats output
 * - Reporter: ONLY generates instructions and formats output, does NOT evaluate
 *
 * **Tools Available:**
 * - send_user_feedback: Send formatted feedback to user
 * - send_file_to_feishu: Send files to user (e.g., reports, logs, generated content)
 *
 * **Tools NOT Available (intentionally restricted):**
 * - task_done: Evaluator's job, not Reporter's
 *
 * **Workflow:**
 * 1. Receive evaluation result from Evaluator
 * 2. Read Task.md and Executor output
 * 3. Generate Executor instructions (if not complete)
 * 4. Format user feedback
 * 5. Send files to user (if applicable)
 * 6. Call send_user_feedback
 *
 * **Output Format:**
 * Reporter generates user-facing messages:
 * - Executor instructions (clear, actionable)
 * - Progress updates (what was accomplished)
 * - Next steps (what needs to be done)
 * - File attachments (reports, logs, etc.)
 */

import type { AgentMessage } from '../types/agent.js';
import type { ReporterContext } from '../types/reporter.js';
import type { TaskProgressEvent } from './executor.js';
import { feishuSdkMcpServer } from '../mcp/feishu-context-mcp.js';
import { loadSkillOrThrow, type ParsedSkill } from '../task/skill-loader.js';
import { BaseAgent, type BaseAgentConfig } from './base-agent.js';

/**
 * Reporter agent configuration.
 */
export interface ReporterConfig extends BaseAgentConfig {}

/**
 * Reporter - Communication and instruction generation specialist.
 *
 * Extends BaseAgent to inherit:
 * - SDK configuration
 * - GLM logging
 * - Error handling
 */
export class Reporter extends BaseAgent {
  private skill?: ParsedSkill;

  constructor(config: ReporterConfig) {
    super(config);
  }

  protected getAgentName(): string {
    return 'Reporter';
  }

  /**
   * Initialize the Reporter agent.
   * Loads the reporter skill which defines allowed tools.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Load skill (required)
    this.skill = await loadSkillOrThrow('reporter');
    this.logger.debug(
      {
        skillName: this.skill.name,
        toolCount: this.skill.allowedTools.length,
      },
      'Reporter skill loaded'
    );

    this.initialized = true;
    this.logger.debug('Reporter initialized');
  }

  /**
   * Generate Executor instructions and user feedback (streaming).
   *
   * Streams messages directly from SDK for real-time user feedback.
   *
   * @param taskMdContent - Full Task.md content
   * @param iteration - Current iteration number
   * @param workerOutput - Executor's output from previous iteration (if any)
   * @param evaluationContent - Evaluation result from Evaluator
   * @yields Agent messages in real-time
   */
  async *report(
    taskMdContent: string,
    iteration: number,
    workerOutput: string | undefined,
    evaluationContent: string
  ): AsyncIterable<AgentMessage> {
    const prompt = Reporter.buildReportPrompt(taskMdContent, iteration, workerOutput, evaluationContent);

    if (!this.initialized) {
      await this.initialize();
    }

    // Skill is required, so allowedTools is always defined after initialize()
    if (!this.skill) {
      throw new Error('Reporter skill not initialized - call initialize() first');
    }

    // Note: task_done is intentionally NOT included (Evaluator's job)
    const sdkOptions = this.createSdkOptions({
      allowedTools: this.skill.allowedTools,
      mcpServers: {
        'feishu-context': feishuSdkMcpServer,
      },
    });

    try {
      for await (const { parsed } of this.queryOnce(prompt, sdkOptions)) {
        yield this.formatMessage(parsed);
      }
    } catch (error) {
      yield this.handleIteratorError(error, 'report');
    }
  }

  /**
   * Send simple feedback to user (streaming).
   *
   * Used for real-time progress updates (start/complete/error events).
   * This is a simplified version that accepts a raw prompt string.
   *
   * @param prompt - Raw prompt string for the Reporter
   * @yields Agent messages in real-time
   */
  async *sendFeedback(prompt: string): AsyncIterable<AgentMessage> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Skill is required, so allowedTools is always defined after initialize()
    if (!this.skill) {
      throw new Error('Reporter skill not initialized - call initialize() first');
    }

    const sdkOptions = this.createSdkOptions({
      allowedTools: this.skill.allowedTools,
      mcpServers: {
        'feishu-context': feishuSdkMcpServer,
      },
    });

    try {
      for await (const { parsed } of this.queryOnce(prompt, sdkOptions)) {
        yield this.formatMessage(parsed);
      }
    } catch (error) {
      yield this.handleIteratorError(error, 'sendFeedback');
    }
  }

  /**
   * Process a single Executor event and yield messages.
   *
   * This is the core interface for IterationBridge to consume Executor events.
   * All Executor events flow through this method:
   * - 'output' events are processed to provide chatId and tool usage instructions
   * - 'start', 'complete', 'error' events trigger Reporter to generate feedback
   *
   * @param event - Executor progress event
   * @param context - Reporter context (taskId, iteration, chatId)
   * @yields AgentMessage - Processed messages
   *
   * @example
   * ```typescript
   * const context = { taskId: 'task-123', iteration: 1, chatId: 'oc_xxx' };
   * for await (const event of executor.executeTask(...)) {
   *   yield* reporter.processEvent(event, context);
   * }
   * ```
   */
  async *processEvent(
    event: TaskProgressEvent,
    context: ReporterContext
  ): AsyncGenerator<AgentMessage> {
    if (!this.initialized) {
      await this.initialize();
    }

    // All events go through Reporter to get chatId and tool instructions
    yield* this.handleReporterEvent(event, context);
  }

  /**
   * Handle all events by generating appropriate prompts and invoking Reporter.
   *
   * @param event - Any Executor event
   * @param context - Reporter context
   * @yields AgentMessage - Reporter-generated messages
   */
  private async *handleReporterEvent(
    event: TaskProgressEvent,
    context: ReporterContext
  ): AsyncGenerator<AgentMessage> {
    const prompt = Reporter.buildEventFeedbackPrompt({
      event,
      taskId: context.taskId,
      iteration: context.iteration,
      chatId: context.chatId,
    });

    if (!prompt) return;

    try {
      for await (const msg of this.sendFeedback(prompt)) {
        yield msg;
      }
    } catch (error) {
      this.logger.warn(
        { err: error, eventType: event.type, taskId: context.taskId },
        'Reporter event handling failed'
      );
      yield {
        content: `⚠️ Reporter error: ${error instanceof Error ? error.message : String(error)}`,
        role: 'assistant',
        messageType: 'error',
      };
    }
  }

  /**
   * Build feedback prompt for any Executor event.
   *
   * Used by IterationBridge for real-time user feedback during task execution.
   * This is a static method so it can be called without instantiating Reporter.
   *
   * @param params - Event details including the full TaskProgressEvent
   * @returns Prompt string for the Reporter
   */
  static buildEventFeedbackPrompt(params: {
    event: TaskProgressEvent;
    taskId: string;
    iteration: number;
    chatId?: string;
  }): string {
    const { event, taskId, iteration, chatId } = params;

    switch (event.type) {
      case 'output':
        return Reporter.buildOutputPrompt(event, taskId, iteration, chatId);
      case 'start':
        return Reporter.buildStartPrompt(event, taskId, iteration, chatId);
      case 'complete':
        return Reporter.buildCompletePrompt(event, taskId, iteration, chatId);
      case 'error':
        return Reporter.buildErrorPrompt(event, taskId, iteration, chatId);
      default:
        return '';
    }
  }

  /**
   * Build prompt for output events (Executor progress updates).
   */
  private static buildOutputPrompt(
    event: TaskProgressEvent & { type: 'output' },
    taskId: string,
    iteration: number,
    chatId?: string
  ): string {
    if (!chatId) {
      // No chatId - return minimal prompt for CLI mode
      return `## Progress Update

**Content**: ${event.content.substring(0, 500)}${event.content.length > 500 ? '...' : ''}`;
    }

    // Escape content for safe inclusion in prompt
    const escapedContent = event.content.replace(/`/g, '\\`').substring(0, 1000);

    return `## Progress Update

**Task ID**: ${taskId}
**Iteration**: ${iteration}
**Message Type**: ${event.messageType}

**Content**:
\`\`\`
${escapedContent}
\`\`\`

---

## 🎯 Your Task

Send this progress update to the user using \`send_user_feedback\`:

1. **Summarize** the progress in a concise, user-friendly way
2. **Use the tool** to send feedback:

\`\`\`
send_user_feedback({
  format: "text",
  content: "Your summary here",
  chatId: "${chatId}"
})
\`\`\`

**Chat ID**: \`${chatId}\`

**⚠️ IMPORTANT**:
- You MUST use the send_user_feedback tool
- Keep the message concise and informative
- Do NOT just output text - use the tool!`;
  }

  /**
   * Build prompt for start events.
   */
  private static buildStartPrompt(
    event: TaskProgressEvent & { type: 'start' },
    taskId: string,
    iteration: number,
    chatId?: string
  ): string {
    if (!chatId) {
      return `## Task Started

**Task ID**: ${taskId}
**Iteration**: ${iteration}
**Task**: ${event.title}

Inform the user that task execution has started.`;
    }

    return `## Task Started

**Task ID**: ${taskId}
**Iteration**: ${iteration}
**Task**: ${event.title}

---

## 🎯 Your Task

Send a start notification to the user using \`send_user_feedback\`:

\`\`\`
send_user_feedback({
  format: "text",
  content: "⚡ Task started: ${event.title}",
  chatId: "${chatId}"
})
\`\`\`

**Chat ID**: \`${chatId}\`

**⚠️ IMPORTANT**: You MUST use the send_user_feedback tool. Do not just output text.`;
  }

  /**
   * Build prompt for complete events.
   */
  private static buildCompletePrompt(
    event: TaskProgressEvent & { type: 'complete' },
    taskId: string,
    _iteration: number,
    chatId?: string
  ): string {
    if (!chatId) {
      return `## Task Completed

**Task ID**: ${taskId}
**Summary File**: ${event.summaryFile}

Send a completion message to the user.`;
    }

    return `## Task Completed

**Task ID**: ${taskId}
**Summary File**: ${event.summaryFile}
**Files Created**: ${event.files.join(', ') || 'None'}

The task execution has completed successfully.

---

## 🎯 Your Task

1. **Check for report files** in the task directory (files ending in \`.md\` that are summaries/reports)
2. **Send report files** using \`send_file_to_feishu\` if any exist
3. **Send completion message** using \`send_user_feedback\`

Example:
\`\`\`
send_user_feedback({
  format: "text",
  content: "✅ Task completed successfully!",
  chatId: "${chatId}"
})
\`\`\`

**Chat ID**: \`${chatId}\`

**⚠️ IMPORTANT**: You MUST use the tools. Do not just output text.`;
  }

  /**
   * Build prompt for error events.
   */
  private static buildErrorPrompt(
    event: TaskProgressEvent & { type: 'error' },
    taskId: string,
    _iteration: number,
    chatId?: string
  ): string {
    if (!chatId) {
      return `## Task Failed

**Error**: ${event.error}

Report the error to the user.`;
    }

    const escapedError = event.error.replace(/"/g, '\\"');

    return `## Task Failed

**Task ID**: ${taskId}
**Error**: ${event.error}

---

## 🎯 Your Task

Send error feedback to the user using \`send_user_feedback\`:

\`\`\`
send_user_feedback({
  format: "text",
  content: "❌ Task execution failed: ${escapedError}",
  chatId: "${chatId}"
})
\`\`\`

**Chat ID**: \`${chatId}\`

**⚠️ IMPORTANT**: You MUST use the send_user_feedback tool. Do not just output text.`;
  }

  /**
   * Build report prompt for Reporter.
   */
  static buildReportPrompt(
    taskMdContent: string,
    iteration: number,
    workerOutput: string | undefined,
    evaluationContent: string
  ): string {
    let prompt = `${taskMdContent}

---

## Current Iteration: ${iteration}

`;

    // Add Executor output if available
    const hasExecutorOutput = workerOutput && workerOutput.trim().length > 0;
    if (hasExecutorOutput) {
      prompt += `## Executor's Previous Output (Iteration ${iteration - 1})

\`\`\`
${workerOutput}
\`\`\`

---

`;
    } else {
      prompt += `## Executor's Previous Output

*No Executor output yet - this is the first iteration.*

---

`;
    }

    // Add evaluation result (markdown format)
    prompt += `## Evaluator's Assessment

${evaluationContent}

---

`;

    // Add report instructions
    prompt += `### Your Reporting Task

**Your Job:**
1. Read the Evaluator's assessment above
2. Format user feedback based on the evaluation
3. Use send_user_feedback to send feedback to user

**What to include in user feedback:**
- Current progress status
- What was accomplished (if any)
- What still needs to be done (if not complete)
- Next steps

**DO NOT:**
❌ Evaluate if task is complete (Evaluator already did)
❌ Generate new instructions (Executor reads evaluation.md directly)

**Remember**: You are the REPORTER.
You ONLY format and communicate feedback to users.
`;

    return prompt;
  }
}
