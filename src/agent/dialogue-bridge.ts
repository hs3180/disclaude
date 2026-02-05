/**
 * AgentDialogueBridge - Manages prompt-based dialogue between Manager and Worker.
 *
 * NEW Architecture (Flow 2):
 * - Task.md content → Worker FIRST (executes/explores)
 * - Worker intermediate output → Manager (progress monitoring, optional feedback)
 * - Worker output with 'result' type → Manager (evaluates/plans)
 * - Manager output → Worker (next steps)
 * - Loop continues until Manager calls task_done
 *
 * Completion detection:
 * - Via task_done tool call only
 * - When called, loop ends and final message is sent to user
 *
 * Session Management:
 * - Each messageId has its own Manager session
 * - Sessions are stored internally in taskSessions Map
 * - This allows multiple parallel tasks within the same chat
 *
 * Execution Phase Detection:
 * - SDK sends 'result' message type when Worker completes (no more tool calls)
 * - Before 'result': Intermediate messages (tool_use, tool_progress, tool_result) → Manager for progress monitoring
 * - After 'result': Execution complete, Manager evaluates and decides next steps
 *
 * **CRITICAL DESIGN PRINCIPLE:**
 * Worker output is NOT automatically sent to users. Only Manager decides what to send.
 * - Worker messages are collected for Manager evaluation only (NOT yielded)
 * - Manager uses MCP tools (send_user_feedback, send_user_card) to send user-facing messages
 * - This ensures Manager is the sole interface layer for user communication
 * - Worker is a background worker - Manager is the user interface
 *
 * **NEW: Progress Updates During Execution**
 * - Manager receives Worker's intermediate messages BEFORE 'result' for real-time monitoring
 * - Manager can send user feedback via `send_user_feedback` tool during execution
 * - This enables real-time updates for long-running tasks
 * - Manager's session persists across both progress updates and completion reports
 */
import type { AgentMessage } from '../types/agent.js';
import { extractText } from '../utils/sdk.js';
import { DIALOGUE } from '../config/constants.js';
import { createLogger } from '../utils/logger.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { Manager } from './manager.js';
import type { Worker } from './worker.js';

const logger = createLogger('AgentDialogueBridge', {});

/**
 * Detect if Worker has completed execution.
 * Checks if the message stream contains a 'result' type message from SDK.
 *
 * @param messages - Messages from Worker
 * @returns true if execution is complete (SDK sent 'result'), false otherwise
 */
export function isExecutionComplete(messages: AgentMessage[]): boolean {
  return messages.some(msg => msg.messageType === 'result');
}

/**
 * Completion signal data from task_done tool call.
 */
export interface CompletionSignal {
  completed: boolean;
  files?: string[];
}

/**
 * Task plan data extracted from manager agent output.
 */
export interface TaskPlanData {
  taskId: string;
  title: string;
  description: string;
  milestones: string[];
  originalRequest: string;
  createdAt: string;
}

/**
 * Agent dialogue configuration.
 */
export interface DialogueBridgeConfig {
  manager: Manager;
  worker: Worker;
  /** Callback when manager generates a task plan */
  onTaskPlanGenerated?: (plan: TaskPlanData) => Promise<void>;
}

/**
 * AgentDialogueBridge - Manages Flow 2 dialogue loop between agents.
 *
 * NEW Flow with Progress Updates:
 * 1. User request from Task.md → Worker (works/explores first)
 * 2. For each intermediate Worker message (before 'result'):
 *    - Send to Manager as progress update
 *    - Manager can send user feedback via send_user_feedback (optional)
 *    - Continue Worker execution
 * 3. When SDK sends 'result' → Worker output → Manager (evaluates/plans)
 * 4. Manager output → Worker (next instructions) OR task_done
 * 5. Loop until Manager calls task_done
 *
 * Key change: Manager receives Worker output during AND after execution.
 * - Before 'result': Progress updates for real-time monitoring
 * - After 'result': Completion report for evaluation and decision-making
 * - Worker works silently - only Manager decides what to send to users
 *
 * **User Communication (Manager-only):**
 * - Manager uses `send_user_feedback` or `send_user_card` MCP tools to communicate with users
 * - These tool calls are handled by feishu-context MCP server and directly sent to Feishu/CLI
 * - Notifications bypass the yielding mechanism and reach users immediately
 * - Worker output is NEVER directly shown to users - Manager decides what to share
 */
export class AgentDialogueBridge {
  readonly manager: Manager;
  readonly worker: Worker;
  /** Maximum iterations from constants - single source of truth */
  readonly maxIterations = DIALOGUE.MAX_ITERATIONS;
  private onTaskPlanGenerated?: (plan: TaskPlanData) => Promise<void>;
  private taskId: string = '';
  private originalRequest: string = '';
  private taskPlanSaved = false;
  private userMessageSent = false;  // Track if any user message was sent

  constructor(config: DialogueBridgeConfig) {
    this.manager = config.manager;
    this.worker = config.worker;
    this.onTaskPlanGenerated = config.onTaskPlanGenerated;
  }

  /**
   * Build evaluation prompt for Manager.
   * Combines: Task.md context + Worker output + Evaluation instruction
   *
   * This ensures Manager has all context needed to:
   * 1. Understand the original request (from Task.md)
   * 2. See what Worker produced
   * 3. Know how to evaluate completion or monitor progress
   * 4. Extract chatId for task_done tool
   *
   * @param taskMdContent - Full Task.md content with original request and metadata
   * @param executionOutput - Worker's output text
   * @param iteration - Current iteration number
   * @param isCompletion - Whether this is a completion report (true) or progress update (false)
   * @returns Complete evaluation prompt
   */
  private buildEvaluationPrompt(
    taskMdContent: string,
    executionOutput: string,
    iteration: number,
    isCompletion: boolean
  ): string {
    const reportType = isCompletion ? 'Completion Report' : 'Progress Report';
    const taskInstruction = isCompletion
      ? `You are the **Manager**. Worker has **completed** work on the task above.

### CRITICAL - How to Signal Completion

When the task is complete, follow this EXACT order:

**Step 1:** Send the final message to the user
\`\`\`
send_user_feedback({
  content: "Your response to the user...",
  chatId: "EXTRACT_CHAT_ID_FROM_TASK_MD"
})
\`\`\`

**Step 2:** Signal completion
\`\`\`
task_done({
  chatId: "EXTRACT_CHAT_ID_FROM_TASK_MD"
})
\`\`\`

Replace EXTRACT_CHAT_ID_FROM_TASK_MD with the Chat ID value from Task.md.

**IMPORTANT:** The user will NOT see your text response. They only see messages sent via send_user_feedback.

### Step 1: Evaluate Completion
Compare Worker output against the Expected Results in Task.md:
- Is the user's original request satisfied?
- Has the expected deliverable been produced?
- Is the response complete and adequate?

### Step 2: Take Action

**If COMPLETE** → Send message via send_user_feedback, then call task_done
**If INCOMPLETE** → Provide next instructions for Worker`
      : `You are the **Manager**. Worker is **still working** on the task above.

### Your Role: Monitor Progress

This is a **progress update** - Worker is still executing:
- Monitor what Worker has done so far
- Check if Worker is on the right track
- Provide real-time feedback to users if needed
- **DO NOT** call task_done yet - execution is not complete

### Waiting State Detection

**IMPORTANT:** Check if Worker's output indicates a WAITING STATE.

**Waiting indicators:**
- Keywords: "waiting", "sleep", "background", "approximately", "will take", "estimated"
- Tool calls: \`sleep\` command with duration > 5 seconds
- Time mentions: "2-3 minutes", "about 30 seconds"
- Phrases: "starting build", "downloading", "compiling", "generating", "in progress"

**If waiting state detected:**
1. Extract what Worker is waiting for
2. Extract estimated time if provided
3. Send user-friendly waiting notification
4. DO NOT call task_done
5. Wait for next message

**Waiting notification template:**
\`\`\`typescript
send_user_feedback({
  content: "⏳ Worker 正在: [activity]\\n\\n预计时间: [estimate]\\n\\n请稍候，完成后会立即通知您...",
  chatId: "EXTRACT_CHAT_ID_FROM_TASK_MD"
})
\`\`\`

**Example:**
Worker says: "Starting build process... [sleep 120]"

You respond:
\`\`\`typescript
send_user_feedback({
  content: "⏳ Worker 正在执行构建任务\\n\\n预计时间: 2-3 分钟\\n\\n请稍候，完成后会立即通知您...",
  chatId: "EXTRACTED_CHAT_ID"
})
\`\`\`

### What You Can Do

**Option 1:** Send progress updates to user
\`\`\`
send_user_feedback({
  content: "Worker is currently working on...",
  chatId: "EXTRACT_CHAT_ID_FROM_TASK_MD"
})
\`\`\`

**Option 2:** Just monitor silently
- No action needed if Worker is progressing well
- Wait for the next completion report to evaluate results

**IMPORTANT:** The user will NOT see your text response. They only see messages sent via send_user_feedback.

**DO NOT** call task_done during progress updates - only in completion reports.`;

    const examples = isCompletion ? `### Examples

For greeting "hi":
send_user_feedback({ content: "Hello! I'm here to help.", chatId: "..." })
task_done({ chatId: "..." })

For code analysis:
send_user_feedback({ content: "Analysis complete. Found 5 functions.", chatId: "..." })
task_done({ chatId: "..." })

For rich card content:
send_user_feedback({ content: { card: {...} }, format: "card", chatId: "..." })
task_done({ chatId: "..." })` : `### Example Progress Update

send_user_feedback({ content: "Worker is reading the source files...", chatId: "..." })`;

    return `${taskMdContent}

---

## ${reportType} (Iteration ${iteration}/${this.maxIterations})

\`\`\`
${executionOutput}
\`\`\`

---

## Your Evaluation Task

${taskInstruction}

${examples}

**IMPORTANT**: The task_done and send_user_feedback tools ARE available. Look for them in your tool list and use them!`;
  }

  /**
   * Record that a user message was sent.
   * Called by FeishuBot when a message is sent to the user.
   */
  recordUserMessageSent(): void {
    this.userMessageSent = true;
  }

  /**
   * Check if any user message has been sent.
   * Used to determine if a no-message warning is needed.
   */
  hasUserMessageBeenSent(): boolean {
    return this.userMessageSent;
  }

  /**
   * Cleanup resources held by the dialogue bridge and agents.
   *
   * **IMPORTANT**: Call this method when the dialogue is complete to prevent memory leaks.
   *
   * Cleanup actions:
   * - Clear session IDs in Manager and Worker agents
   * - Release SDK conversation context resources
   * - Reset dialogue bridge state
   * - Allow SDK to clean up MCP server instances associated with sessions
   *
   * **Memory Leak Prevention:**
   * - Sessions are stored in both Manager and Worker agents
   * - Without cleanup, session IDs accumulate and hold SDK resources
   * - MCP server instances (feishu-context, playwright) are tied to sessions
   * - SDK automatically cleans up per-query MCP instances when sessions end
   *
   * **Resource Lifecycle:**
   * 1. Dialogue starts → Manager/Worker create new sessions
   * 2. Each query → SDK creates temporary MCP server instances
   * 3. Dialogue ends → cleanup() called → Session IDs cleared
   * 4. SDK detects session end → Releases MCP instances and resources
   *
   * Note: The feishuSdkMcpServer is a module-level singleton that persists
   * across dialogues. It is intentionally not cleaned up here.
   */
  cleanup(): void {
    logger.debug({ taskId: this.taskId }, 'Cleaning up dialogue bridge');
    this.manager.cleanup();
    this.worker.cleanup();
    this.taskId = '';
    this.originalRequest = '';
    this.taskPlanSaved = false;
    this.userMessageSent = false;
  }

  /**
   * Generate a unique task ID.
   */
  private generateTaskId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `dialogue-task-${timestamp}-${random}`;
  }

  /**
   * Detect completion via task_done tool call only.
   * Scans message content for tool_use blocks with name 'task_done'.
   *
   * @param messages - Messages to scan for completion signal
   * @returns Completion signal data if found, null otherwise
   */
  private detectCompletion(messages: AgentMessage[]): CompletionSignal | null {
    for (const msg of messages) {
      const {content, metadata} = msg;

      // Debug: log all message types for troubleshooting
      logger.debug({
        messageType: msg.messageType,
        contentType: Array.isArray(content) ? `array[${content.length}]` : typeof content,
        contentTypes: Array.isArray(content) ? content.map(b => b.type) : [typeof content],
        toolName: metadata?.toolName,
      }, 'detectCompletion: checking message');

      // Handle array content (ContentBlock[]) - raw SDK format
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use' && block.name === 'task_done') {
            const input = block.input as Record<string, unknown> | undefined;
            const files = input?.files as string[] | undefined;
            logger.info({ source: 'tool_call' }, 'Completion detected via task_done tool');
            return {
              completed: true,
              files,
            };
          }
        }
      }

      // Handle parsed SDK messages - tool_use info stored in metadata
      // parseSDKMessage() converts tool_use blocks to string content
      // and stores tool info in metadata.toolName and metadata.toolInput
      // Note: MCP tools are namespaced as "mcp__server-name__tool-name"
      if (msg.messageType === 'tool_use' &&
          (metadata?.toolName === 'task_done' ||
           metadata?.toolName?.endsWith('__task_done'))) {
        const toolInput = metadata.toolInput as Record<string, unknown> | undefined;
        const files = toolInput?.files as string[] | undefined;
        logger.info({ source: 'metadata', toolName: metadata.toolName }, 'Completion detected via task_done tool');
        return {
          completed: true,
          files,
        };
      }
    }

    logger.debug({ messageCount: messages.length }, 'detectCompletion: no completion signal found');
    return null;
  }

  /**
   * Extract task plan from manager agent output.
   * Looks for structured plan sections in the output.
   */
  private extractTaskPlan(output: string): TaskPlanData | null {
    const lines = output.split('\n');

    let title = 'Untitled Task';
    let description = '';
    const milestones: string[] = [];

    // Try to extract title from headers
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') && trimmed.length > 2) {
        title = trimmed.replace(/^#+\s*/, '').trim();
        break;
      }
    }

    // Try to extract milestones from numbered lists or bullet points
    let inMilestones = false;
    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.toLowerCase().includes('milestone') ||
          trimmed.toLowerCase().includes('step') ||
          trimmed.toLowerCase().includes('plan')) {
        inMilestones = true;
        continue;
      }

      if (inMilestones || /^\d+\./.test(trimmed) || /^[-*]/.test(trimmed)) {
        const milestone = trimmed.replace(/^\d+\.?\s*/, '').replace(/^[-*]\s*/, '').trim();
        if (milestone && !milestone.startsWith('#')) {
          milestones.push(milestone);
        }
      }
    }

    if (milestones.length === 0) {
      description = output.substring(0, 1000);
    } else {
      description = output.substring(0, 500);
    }

    return {
      taskId: this.generateTaskId(),
      title,
      description,
      milestones,
      originalRequest: this.originalRequest,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Build a warning message when task completes without sending any user message.
   *
   * @param reason - Why the task ended (e.g., 'task_done', 'max_iterations')
   * @param taskId - Optional task ID for context
   * @returns Formatted warning message
   */
  buildNoMessageWarning(reason: string, taskId?: string): string {
    const parts = [
      '⚠️ **任务完成但无反馈消息**',
      '',
      `结束原因: ${reason}`,
    ];

    if (taskId) {
      parts.push(`任务 ID: ${taskId}`);
    }

    parts.push('', '这可能表示:');
    parts.push('- Agent 没有生成任何输出');
    parts.push('- 所有消息都通过内部工具处理');
    parts.push('- 可能存在配置问题');

    return parts.join('\n');
  }

  /**
   * Build execution instruction for Worker's first prompt.
   *
   * This tells Worker:
   * - Its role and responsibilities
   * - How to interpret the task.md
   * - What to focus on when working
   *
   * @returns Execution instruction string
   */
  private buildExecutionInstruction(): string {
    return `## Your Role

You are the **Worker**. Your job is to execute the task described above.

### What You Should Do

1. **Read the task carefully** - Review Original Request and Expected Results
2. **Use tools appropriately** - You have full access to development tools
3. **Execute the work** - Complete what's needed to satisfy the Expected Results
4. **Report clearly** - Provide a clear summary of what you did and the outcomes

### Important Notes

- Focus on **execution** - get the work done
- The Manager will evaluate your results and decide next steps
- You don't need to signal completion - just report what you did
- Be thorough but efficient

**Now execute the task.**`;
  }

  /**
   * Send progress update to Manager during Worker execution.
   *
   * This allows Manager to monitor Worker's progress in real-time and optionally
   * send user feedback via send_user_feedback tool.
   *
   * @param taskMdContent - Full Task.md content
   * @param intermediateOutput - Worker's intermediate output
   * @param iteration - Current iteration number
   * @returns true if Manager called task_done (should not happen during progress)
   */
  private async sendProgressUpdate(
    taskMdContent: string,
    intermediateOutput: string,
    iteration: number
  ): Promise<boolean> {
    const progressPrompt = this.buildEvaluationPrompt(
      taskMdContent,
      intermediateOutput,
      iteration,
      false  // isCompletion = false for progress updates
    );

    logger.debug({
      iteration,
      outputLength: intermediateOutput.length,
    }, 'Sending progress update to Manager');

    const managerProgressMessages: AgentMessage[] = [];
    for await (const managerMsg of this.manager.queryStream(progressPrompt)) {
      managerProgressMessages.push(managerMsg);

      if (managerMsg.metadata?.toolName) {
        logger.debug({
          iteration,
          toolName: managerMsg.metadata.toolName,
          toolInput: managerMsg.metadata.toolInput,
        }, 'Manager tool call during progress update');
      }
    }

    const progressCompletion = this.detectCompletion(managerProgressMessages);
    if (progressCompletion?.completed) {
      logger.warn(
        { iteration },
        'Manager called task_done during progress update - unexpected but accepting'
      );
      return true;  // Task completed
    }

    return false;  // Continue execution
  }

  /**
   * Collect Worker messages and send progress updates to Manager.
   *
   * Streams Worker's output and sends intermediate messages to Manager for
   * real-time monitoring. Continues until SDK sends 'result' message type.
   *
   * @param currentPrompt - Worker's current prompt
   * @param taskMdContent - Full Task.md content
   * @param iteration - Current iteration number
   * @returns Worker's execution messages and completion status
   */
  private async collectWorkerMessages(
    currentPrompt: string,
    taskMdContent: string,
    iteration: number
  ): Promise<{ messages: AgentMessage[]; completed: boolean }> {
    const executionMessages: AgentMessage[] = [];

    logger.debug({ iteration, promptLength: currentPrompt.length }, 'Worker working');

    for await (const msg of this.worker.queryStream(currentPrompt)) {
      executionMessages.push(msg);

      // Send intermediate messages to Manager for progress monitoring
      if (msg.messageType && msg.messageType !== 'result') {
        const intermediateOutput = extractText(msg);
        const completed = await this.sendProgressUpdate(taskMdContent, intermediateOutput, iteration);

        if (completed) {
          return { messages: executionMessages, completed: true };
        }
      }
    }

    return { messages: executionMessages, completed: false };
  }

  /**
   * Query Manager with completion report.
   *
   * Sends Worker's complete output to Manager for evaluation and decision-making.
   * Manager evaluates completion and either calls task_done or provides next instructions.
   *
   * @param taskMdContent - Full Task.md content
   * @param executionOutput - Worker's complete output
   * @param iteration - Current iteration number
   * @returns Manager messages and completion status
   */
  private async queryManagerCompletion(
    taskMdContent: string,
    executionOutput: string,
    iteration: number
  ): Promise<{ messages: AgentMessage[]; completed: boolean; output: string }> {
    const evaluationPrompt = this.buildEvaluationPrompt(
      taskMdContent,
      executionOutput,
      iteration,
      true  // isCompletion = true for completion report
    );

    logger.debug({ iteration }, 'Sending completion report to Manager');

    const managerMessages: AgentMessage[] = [];
    for await (const msg of this.manager.queryStream(evaluationPrompt)) {
      managerMessages.push(msg);

      if (msg.metadata?.toolName) {
        logger.debug({
          iteration,
          toolName: msg.metadata.toolName,
          toolInput: msg.metadata.toolInput,
        }, 'Manager tool call detected');
      }
    }

    const completion = this.detectCompletion(managerMessages);
    const managerOutput = managerMessages.map(msg => extractText(msg)).join('');

    logger.debug({
      iteration,
      outputLength: managerOutput.length,
      completed: completion?.completed,
    }, 'Manager completion response received');

    return {
      messages: managerMessages,
      completed: completion?.completed ?? false,
      output: managerOutput,
    };
  }

  /**
   * Save task plan on first iteration.
   *
   * Extracts and saves task plan from Manager's first output.
   *
   * @param managerOutput - Manager's output text
   * @param iteration - Current iteration number
   */
  private async saveTaskPlanIfNeeded(managerOutput: string, iteration: number): Promise<void> {
    if (iteration === 1 && this.onTaskPlanGenerated && !this.taskPlanSaved) {
      const plan = this.extractTaskPlan(managerOutput);
      if (plan) {
        try {
          await this.onTaskPlanGenerated(plan);
          this.taskPlanSaved = true;
          logger.info({ taskId: plan.taskId }, 'Task plan saved');
        } catch (error) {
          logger.error({ err: error }, 'Failed to save task plan');
        }
      }
    }
  }

  /**
   * Build a warning message when max iterations is reached.
   *
   * @param iteration - Final iteration number
   * @returns Formatted warning message
   */
  private buildMaxIterationsWarning(iteration: number): AgentMessage {
    logger.warn({ iteration }, 'Dialogue reached max iterations without completion');

    return {
      content: `Warning: Dialogue reached max iterations (${this.maxIterations}) but task may not be complete.

Possible reasons:
1. Task complexity requires more iterations
2. Manager did not call task_done tool to mark completion

Suggestions:
- Use /reset to clear conversation and resubmit
- Or check and modify task description for clarity
- If this is an analysis task, may need more explicit completion criteria`,
      role: 'assistant',
      messageType: 'error',
    };
  }

  /**
   * Process a single dialogue iteration.
   *
   * Coordinates the Worker-Manager interaction for one iteration:
   * 1. Worker executes the current prompt
   * 2. Manager evaluates the completion status
   * 3. Either completes or prepares for next iteration
   *
   * @param currentPrompt - Current prompt for Worker
   * @param taskMdContent - Full Task.md content
   * @param iteration - Current iteration number
   * @returns Object containing completion status and next prompt (if any)
   */
  private async processIteration(
    currentPrompt: string,
    taskMdContent: string,
    iteration: number
  ): Promise<{ completed: boolean; nextPrompt?: string }> {
    // === Phase 1: Worker executes ===
    const { messages: executionMessages, completed: workerCompleted } =
      await this.collectWorkerMessages(currentPrompt, taskMdContent, iteration);

    // Early exit if Manager signaled completion during progress updates
    if (workerCompleted) {
      return { completed: true };
    }

    // === Phase 2: Validate execution completion ===
    const executionComplete = isExecutionComplete(executionMessages);
    if (!executionComplete) {
      logger.warn({ iteration }, 'No result message found - unexpected state');
      // Continue to next iteration to attempt recovery
      return { completed: false, nextPrompt: currentPrompt };
    }

    const executionOutput = executionMessages.map(msg => extractText(msg)).join('');
    logger.debug({
      iteration,
      executionOutputLength: executionOutput.length,
    }, 'Worker execution phase complete');

    // === Phase 3: Manager evaluates and decides ===
    const { completed, output: managerOutput } =
      await this.queryManagerCompletion(taskMdContent, executionOutput, iteration);

    // Save task plan on first iteration
    await this.saveTaskPlanIfNeeded(managerOutput, iteration);

    if (completed) {
      logger.info({ iteration }, 'Task completed via task_done');
      return { completed: true };
    }

    // Manager's output becomes the next Worker prompt
    return { completed: false, nextPrompt: managerOutput };
  }

  /**
   * Run a dialogue loop (Flow 2).
   *
   * NEW FLOW with Progress Updates:
   * 1. Worker works on prompt, SDK streams messages
   * 2. For each intermediate message (before 'result'):
   *    - Send to Manager as progress update
   *    - Manager can optionally send user feedback via send_user_feedback
   *    - Continue collecting Worker messages
   * 3. When SDK sends 'result', execution is complete → send completion report to Manager
   * 4. Manager evaluates and either:
   *    - Calls task_done → task done
   *    - Provides next instructions → becomes new Worker prompt
   * 5. Loop continues until task_done is called
   *
   * Key insight: SDK's 'result' message type signals execution completion.
   * - Before 'result': Intermediate messages → Manager for progress monitoring (dialogue continues)
   * - After 'result': Completion report → Manager for evaluation and decision-making
   *
   * @param taskPath - Path to Task.md file
   * @param originalRequest - Original user request text
   * @param chatId - Feishu chat ID
   * @param messageId - Unique message ID for session management (each task has its own session)
   * @returns Async iterable of messages from manager agent (to show user)
   */
  async *runDialogue(
    taskPath: string,
    originalRequest: string,
    chatId: string,
    _messageId: string  // Reserved for future use
  ): AsyncIterable<AgentMessage> {
    this.taskId = path.basename(taskPath, '.md');
    this.originalRequest = originalRequest;
    this.taskPlanSaved = false;

    const taskMdContent = await fs.readFile(taskPath, 'utf-8');
    const executionInstruction = this.buildExecutionInstruction();
    let currentPrompt = `${taskMdContent}

---

${executionInstruction}`;
    let iteration = 0;
    let taskCompleted = false;

    logger.info(
      { taskId: this.taskId, chatId, maxIterations: this.maxIterations },
      'Starting Flow 2: Worker first, SDK "result" type signals completion'
    );

    // Main dialogue loop: Worker → Manager → Worker → ...
    while (iteration < this.maxIterations) {
      iteration++;

      const result = await this.processIteration(currentPrompt, taskMdContent, iteration);

      if (result.completed) {
        taskCompleted = true;
        break;
      }

      // Continue to next iteration with new prompt
      if (result.nextPrompt) {
        currentPrompt = result.nextPrompt;
      }
    }

    // Warn if max iterations reached without completion
    if (!taskCompleted && iteration >= this.maxIterations) {
      yield this.buildMaxIterationsWarning(iteration);
    }
  }
}
