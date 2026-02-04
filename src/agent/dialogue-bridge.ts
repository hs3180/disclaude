/**
 * AgentDialogueBridge - Manages prompt-based dialogue between OrchestrationAgent and ExecutionAgent.
 *
 * NEW Architecture (Flow 2):
 * - Task.md content → ExecutionAgent FIRST (executes/explores)
 * - ExecutionAgent output with 'result' type → OrchestrationAgent (evaluates/plans)
 * - OrchestrationAgent output → ExecutionAgent (next steps)
 * - Loop continues until OrchestrationAgent calls task_done
 *
 * Completion detection:
 * - Via task_done tool call only
 * - When called, loop ends and final message is sent to user
 *
 * Session Management:
 * - Each messageId has its own OrchestrationAgent session
 * - Sessions are stored internally in taskSessions Map
 * - This allows multiple parallel tasks within the same chat
 *
 * Execution Phase Detection:
 * - SDK sends 'result' message type when ExecutionAgent completes (no more tool calls)
 * - Before 'result': Execution is in progress, send UPDATES to OrchestrationAgent for display only
 * - After 'result': Execution complete, OrchestrationAgent evaluates and decides next steps
 */
import type { AgentMessage } from '../types/agent.js';
import { extractText } from '../utils/sdk.js';
import { DIALOGUE } from '../config/constants.js';
import { createLogger } from '../utils/logger.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { OrchestrationAgent } from './orchestration-agent.js';
import type { ExecutionAgent } from './execution-agent.js';

const logger = createLogger('AgentDialogueBridge', {});

/**
 * Detect if ExecutionAgent has completed execution.
 * Checks if the message stream contains a 'result' type message from SDK.
 *
 * @param messages - Messages from ExecutionAgent
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
 * Task plan data extracted from orchestration agent output.
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
  orchestrationAgent: OrchestrationAgent;
  executionAgent: ExecutionAgent;
  /** Callback when orchestration agent generates a task plan */
  onTaskPlanGenerated?: (plan: TaskPlanData) => Promise<void>;
}

/**
 * AgentDialogueBridge - Manages Flow 2 dialogue loop between agents.
 *
 * NEW Flow:
 * 1. User request from Task.md → ExecutionAgent (works/explores first)
 * 2. When SDK sends 'result' → ExecutionAgent output → OrchestrationAgent (evaluates/plans)
 * 3. OrchestrationAgent output → ExecutionAgent (next instructions) OR task_done
 * 4. Loop until OrchestrationAgent calls task_done
 *
 * Key change: OrchestrationAgent only receives ExecutionAgent output AFTER execution completes.
 * During execution, UPDATES are sent for display but don't trigger new ExecutionAgent rounds.
 */
export class AgentDialogueBridge {
  readonly orchestrationAgent: OrchestrationAgent;
  readonly executionAgent: ExecutionAgent;
  /** Maximum iterations from constants - single source of truth */
  readonly maxIterations = DIALOGUE.MAX_ITERATIONS;
  private onTaskPlanGenerated?: (plan: TaskPlanData) => Promise<void>;
  private taskId: string = '';
  private originalRequest: string = '';
  private taskPlanSaved = false;
  private userMessageSent = false;  // Track if any user message was sent

  constructor(config: DialogueBridgeConfig) {
    this.orchestrationAgent = config.orchestrationAgent;
    this.executionAgent = config.executionAgent;
    this.onTaskPlanGenerated = config.onTaskPlanGenerated;
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
   * Extract task plan from orchestration agent output.
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
   * Build complete evaluation prompt for OrchestrationAgent.
   * Combines: Task.md context + Execution result + Evaluation instruction
   *
   * This ensures OrchestrationAgent has all context needed to:
   * 1. Understand the original request (from Task.md)
   * 2. See what ExecutionAgent produced
   * 3. Know how to evaluate completion
   * 4. Extract chatId for task_done tool
   *
   * @param taskMdContent - Full Task.md content with original request and metadata
   * @param executionOutput - ExecutionAgent's output text
   * @param iteration - Current iteration number
   * @returns Complete evaluation prompt
   */
  private buildEvaluationPrompt(
    taskMdContent: string,
    executionOutput: string,
    iteration: number
  ): string {
    return `${taskMdContent}

---

## ExecutionAgent Result (Iteration ${iteration}/${this.maxIterations})

\`\`\`
${executionOutput}
\`\`\`

---

## Your Evaluation Task

You are the **OrchestrationAgent**. ExecutionAgent has completed work on the task above.

### CRITICAL - How to Signal Completion

When the task is complete, follow this EXACT order:

**Step 1:** Send the final message to the user
\`\`\`
send_user_feedback({
  message: "Your response to the user...",
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

**IMPORTANT:** The user will NOT see your text response. They only see messages sent via send_user_feedback or send_user_card.

### Step 1: Evaluate Completion
Compare ExecutionAgent output against the Expected Results in Task.md:
- Is the user's original request satisfied?
- Has the expected deliverable been produced?
- Is the response complete and adequate?

### Step 2: Take Action

**If COMPLETE** → Send message via send_user_feedback, then call task_done
**If INCOMPLETE** → Provide next instructions for ExecutionAgent

### Examples

For greeting "hi":
send_user_feedback({ message: "Hello! I'm here to help.", chatId: "..." })
task_done({ chatId: "..." })

For code analysis:
send_user_feedback({ message: "Analysis complete. Found 5 functions.", chatId: "..." })
task_done({ chatId: "..." })

**IMPORTANT**: The task_done and send_user_feedback tools ARE available. Look for them in your tool list and use them!`;
  }

  /**
   * Build execution instruction for ExecutionAgent's first prompt.
   *
   * This tells ExecutionAgent:
   * - Its role and responsibilities
   * - How to interpret the task.md
   * - What to focus on when working
   *
   * @returns Execution instruction string
   */
  private buildExecutionInstruction(): string {
    return `## Your Role

You are the **ExecutionAgent**. Your job is to execute the task described above.

### What You Should Do

1. **Read the task carefully** - Review Original Request and Expected Results
2. **Use tools appropriately** - You have full access to development tools
3. **Execute the work** - Complete what's needed to satisfy the Expected Results
4. **Report clearly** - Provide a clear summary of what you did and the outcomes

### Important Notes

- Focus on **execution** - get the work done
- The OrchestrationAgent will evaluate your results and decide next steps
- You don't need to signal completion - just report what you did
- Be thorough but efficient

**Now execute the task.**`;
  }

  /**
   * Run a dialogue loop (Flow 2).
   *
   * NEW FLOW:
   * 1. ExecutionAgent works on prompt, SDK streams messages
   * 2. When SDK sends 'result', execution is complete → send to OrchestrationAgent
   * 3. OrchestrationAgent evaluates and either:
   *    - Calls task_done → task done
   *    - Provides next instructions → becomes new ExecutionAgent prompt
   * 4. Loop continues until task_done is called
   *
   * Key insight: SDK's 'result' message type signals execution completion.
   * Before 'result', ExecutionAgent is still working (tool calls in progress).
   *
   * @param taskPath - Path to Task.md file
   * @param originalRequest - Original user request text
   * @param chatId - Feishu chat ID
   * @param messageId - Unique message ID for session management (each task has its own session)
   * @returns Async iterable of messages from orchestration agent (to show user)
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

    // Read Task.md content (contains chatId, original request, expected results)
    // Task.md will be included in evaluation prompt for OrchestrationAgent
    const taskMdContent = await fs.readFile(taskPath, 'utf-8');

    // Build first prompt: task.md + execution instruction
    const executionInstruction = this.buildExecutionInstruction();
    let currentPrompt = `${taskMdContent}

---

${executionInstruction}`;
    let iteration = 0;
    let taskCompleted = false;  // Track if task completed successfully

    logger.info(
      { taskId: this.taskId, chatId, maxIterations: this.maxIterations },
      'Starting Flow 2: ExecutionAgent first, SDK "result" type signals completion'
    );

    while (iteration < this.maxIterations) {
      iteration++;

      // === ExecutionAgent executes ===
      logger.debug({ iteration, promptLength: currentPrompt.length },
                   'ExecutionAgent working');

      // Collect all messages from ExecutionAgent
      const executionMessages: AgentMessage[] = [];
      for await (const msg of this.executionAgent.queryStream(currentPrompt)) {
        executionMessages.push(msg);
        // Optionally yield intermediate messages for visibility
        // (These are tool_use, tool_progress, etc. - not the final result)
      }

      // Check if execution is complete by looking for 'result' message type
      const executionComplete = isExecutionComplete(executionMessages);
      const executionOutput = executionMessages.map(msg => extractText(msg)).join('');

      logger.debug({
        iteration,
        executionComplete,
        executionOutputLength: executionOutput.length,
        executionOutput: executionOutput
      }, 'ExecutionAgent output received');

      if (!executionComplete) {
        // Execution still in progress: send PROGRESS_UPDATE to OrchestrationAgent
        // This is only for display purposes - doesn't trigger new ExecutionAgent round
        logger.debug({ iteration }, 'Execution in progress, sending PROGRESS_UPDATE');

        const progressPrompt = '[PROGRESS_UPDATE] - Execution in progress (iteration ' + iteration + ')\n\n' + executionOutput + '\n\nDO NOT call task_done - wait for the completed result in the next message.';

        // OrchestrationAgent receives progress update but its response is not used as next prompt
        for await (const _msg of this.orchestrationAgent.queryStream(progressPrompt)) {
          // Optionally yield to user for visibility
          // yield _msg;
        }

        // Continue waiting for ExecutionAgent to complete
        // Keep the same prompt for next iteration (ExecutionAgent session continues)
        continue;
      }

      // === Execution complete: build evaluation prompt and send to OrchestrationAgent ===
      logger.debug({ iteration }, 'Execution complete, sending to OrchestrationAgent for evaluation');

      // Build complete evaluation prompt: Task.md + execution result + evaluation instruction
      const evaluationPrompt = this.buildEvaluationPrompt(
        taskMdContent,    // Task.md full content
        executionOutput,  // ExecutionAgent output
        iteration
      );

      const orchestrationMessages: AgentMessage[] = [];
      for await (const msg of this.orchestrationAgent.queryStream(evaluationPrompt)) {
        orchestrationMessages.push(msg);
        // Do NOT yield - OrchestrationAgent output is for internal evaluation only
        // User-facing messages come from send_user_feedback/send_user_card tools
      }

      // === Check for task_done tool call ===
      const completion = this.detectCompletion(orchestrationMessages);
      if (completion?.completed) {
        taskCompleted = true;  // Mark task as completed
        logger.info({ iteration },
                    'Task completed via task_done');
        break;  // Exit loop
      }

      const orchestrationOutput = orchestrationMessages
        .map(msg => extractText(msg))
        .join('');

      logger.debug({
        iteration,
        outputLength: orchestrationOutput.length,
        output: orchestrationOutput
      }, 'OrchestrationAgent output received');

      // === Save task plan on first orchestration output ===
      if (iteration === 1 && this.onTaskPlanGenerated && !this.taskPlanSaved) {
        const plan = this.extractTaskPlan(orchestrationOutput);
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

      // === Orchestration output becomes prompt for next ExecutionAgent round ===
      currentPrompt = orchestrationOutput;
    }

    // Only show max iterations warning if task did not complete successfully
    if (!taskCompleted && iteration >= this.maxIterations) {
      logger.warn({ iteration }, 'Dialogue reached max iterations without completion');
      yield {
        content: 'Warning: Dialogue reached max iterations (' + this.maxIterations + ') but task may not be complete.\n\n' +
          'Possible reasons:\n' +
          '1. Task complexity requires more iterations\n' +
          '2. OrchestrationAgent did not call task_done tool to mark completion\n\n' +
          'Suggestions:\n' +
          '- Use /reset to clear conversation and resubmit\n' +
          '- Or check and modify task description for clarity\n' +
          '- If this is an analysis task, may need more explicit completion criteria',
        role: 'assistant',
        messageType: 'error',
      };
    }
  }
}
