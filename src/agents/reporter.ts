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
import type { SkillAgent, UserInput } from './types.js';
import { createFeishuSdkMcpServer } from '../mcp/feishu-context-mcp.js';
import { BaseAgent, type BaseAgentConfig } from './base-agent.js';

/**
 * Reporter-specific allowed tools.
 * Defined directly in code instead of loading from skill files.
 */
const REPORTER_ALLOWED_TOOLS = ['send_user_feedback', 'send_file_to_feishu'];

/**
 * Reporter - Communication and instruction generation specialist.
 *
 * Extends BaseAgent to inherit:
 * - SDK configuration
 * - GLM logging
 * - Error handling
 */
export class Reporter extends BaseAgent implements SkillAgent {
  /** Agent type identifier (Issue #282) */
  readonly type = 'skill' as const;

  /** Agent name for logging */
  readonly name = 'Reporter';

  constructor(config: BaseAgentConfig) {
    super(config);
  }

  protected getAgentName(): string {
    return 'Reporter';
  }

  /**
   * Initialize the Reporter agent.
   * No skill loading needed - allowedTools are defined directly in code.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.logger.debug(
      { toolCount: REPORTER_ALLOWED_TOOLS.length },
      'Reporter initialized'
    );
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

    // Note: task_done is intentionally NOT included (Evaluator's job)
    const sdkOptions = this.createSdkOptions({
      allowedTools: REPORTER_ALLOWED_TOOLS,
      mcpServers: {
        'feishu-context': createFeishuSdkMcpServer(),
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

    const sdkOptions = this.createSdkOptions({
      allowedTools: REPORTER_ALLOWED_TOOLS,
      mcpServers: {
        'feishu-context': createFeishuSdkMcpServer(),
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

    if (!prompt) {return;}

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
   *
   * Optimized for concise feedback (Issue #7):
   * - Shorter prompt template
   * - Clear guidance for brief output
   * - Action-oriented formatting
   */
  private static buildOutputPrompt(
    event: TaskProgressEvent & { type: 'output' },
    _taskId: string,
    _iteration: number,
    chatId?: string
  ): string {
    if (!chatId) {
      // No chatId - return minimal prompt for CLI mode
      return `## Progress

${event.content.substring(0, 300)}${event.content.length > 300 ? '...' : ''}`;
    }

    // Truncate content for brevity
    const content = event.content.substring(0, 500);

    return `## 进度更新

${content}

---

**发送反馈** (使用 send_user_feedback):

**要求**:
- 🎯 **精简** - 一句话说清楚做了什么
- 📄 **格式** - 用 emoji + 简短描述，例如: \`📄 读取 src/foo.ts\`
- ⚡ **合并** - 如果是连续的小操作，合并报告

**Chat ID**: \`${chatId}\`

直接调用工具发送，不要输出额外文字。`;
  }

  /**
   * Build prompt for start events.
   *
   * Optimized for concise feedback (Issue #7).
   */
  private static buildStartPrompt(
    event: TaskProgressEvent & { type: 'start' },
    _taskId: string,
    _iteration: number,
    chatId?: string
  ): string {
    if (!chatId) {
      return `⚡ 开始: ${event.title}`;
    }

    return `## 任务开始

**任务**: ${event.title}

---

用 send_user_feedback 发送简短通知:

\`\`\`
send_user_feedback({
  format: "text",
  content: "⚡ ${event.title}",
  chatId: "${chatId}"
})
\`\`\`

**Chat ID**: \`${chatId}\`

直接调用工具。`;
  }

  /**
   * Build prompt for complete events.
   *
   * Optimized for concise feedback (Issue #7).
   */
  private static buildCompletePrompt(
    event: TaskProgressEvent & { type: 'complete' },
    _taskId: string,
    _iteration: number,
    chatId?: string
  ): string {
    if (!chatId) {
      return `✅ 完成: ${event.summaryFile}`;
    }

    const filesInfo = event.files.length > 0 ? `\n**文件**: ${event.files.join(', ')}` : '';

    return `## 任务完成

**摘要**: ${event.summaryFile}${filesInfo}

---

1. 如有报告文件，用 send_file_to_feishu 发送
2. 用 send_user_feedback 发送完成通知

\`\`\`
send_user_feedback({
  format: "text",
  content: "✅ 任务完成",
  chatId: "${chatId}"
})
\`\`\`

**Chat ID**: \`${chatId}\`

直接调用工具。`;
  }

  /**
   * Build prompt for error events.
   *
   * Optimized for concise feedback (Issue #7).
   */
  private static buildErrorPrompt(
    event: TaskProgressEvent & { type: 'error' },
    _taskId: string,
    _iteration: number,
    chatId?: string
  ): string {
    if (!chatId) {
      return `❌ 错误: ${event.error}`;
    }

    const escapedError = event.error.replace(/"/g, '\\"');

    return `## 任务失败

**错误**: ${event.error}

---

用 send_user_feedback 发送错误通知:

\`\`\`
send_user_feedback({
  format: "text",
  content: "❌ ${escapedError}",
  chatId: "${chatId}"
})
\`\`\`

**Chat ID**: \`${chatId}\`

直接调用工具。`;
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

  /**
   * Execute a single task and yield results.
   * Implements SkillAgent interface.
   *
   * @param input - Task input as string or structured data
   * @yields AgentMessage responses
   */
  async *execute(input: string | UserInput[]): AsyncGenerator<AgentMessage> {
    // Convert UserInput[] to string if needed
    const prompt: string = typeof input === 'string'
      ? input
      : input.map(u => u.content).join('\n');

    yield* this.sendFeedback(prompt);
  }
}
