/**
 * Long task manager - orchestrates the planning and execution workflow.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { TaskPlanner } from './planner.js';
import { SubtaskExecutor } from './executor.js';
import { TaskTracker } from '../utils/task-tracker.js';
import type {
  LongTaskPlan,
  LongTaskState,
  LongTaskConfig,
} from './types.js';

/**
 * Manages the complete long task workflow.
 */
export class LongTaskManager {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly apiBaseUrl: string | undefined;
  private readonly config: LongTaskConfig;
  private activeTasks: Map<string, LongTaskState>;
  private readonly taskTracker: TaskTracker;

  constructor(
    apiKey: string,
    model: string,
    apiBaseUrl: string | undefined,
    config: LongTaskConfig
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.apiBaseUrl = apiBaseUrl;
    this.config = config;
    this.activeTasks = new Map();
    this.taskTracker = new TaskTracker(config.workspaceBaseDir);
  }

  /**
   * Start a new long task workflow.
   */
  async startLongTask(userRequest: string): Promise<void> {
    const taskId = `task-${Date.now()}`;
    const timeoutMs = this.config.taskTimeoutMs || 24 * 60 * 60 * 1000; // Default 24 hours
    const abortController = new AbortController();

    // Store abort controller for cancellation
    this.config.abortSignal = abortController.signal;

    // Create timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        abortController.abort();
        reject(new Error(`Task timeout after ${timeoutMs / 1000 / 60} minutes`));
      }, timeoutMs);
    });

    try {
      // Send initial message
      await this.config.sendMessage(
        this.config.chatId,
        `🚀 **Starting Long Task Workflow**\n\n📋 Request: ${userRequest}\n\n⏳ Planning task breakdown...`
      );

      // Race between task execution and timeout
      await Promise.race([
        this.executeTask(taskId, userRequest, abortController.signal),
        timeoutPromise,
      ]);
    } catch (error) {
      console.error(`[LongTask] Task ${taskId} failed:`, error);

      // Check if aborted
      if (error instanceof Error && error.name === 'AbortError') {
        const errorMsg = '⚠️ **Long Task Cancelled**\n\nThe task was cancelled.';
        await this.config.sendMessage(this.config.chatId, errorMsg);
      } else {
        // Improved error message with full context
        const errorMsg = `❌ **Long Task Failed**\n\nError: ${error instanceof Error ? error.message : String(error)}\n\n${error instanceof Error && error.stack ? `Stack: ${error.stack}` : ''}`;
        await this.config.sendMessage(this.config.chatId, errorMsg);
      }
    } finally {
      // Clean up on completion or error
      this.activeTasks.delete(taskId);
      this.config.abortSignal = undefined;
      abortController.abort(); // Ensure all async operations are cancelled
    }
  }

  /**
   * Execute the task workflow.
   */
  private async executeTask(
    taskId: string,
    userRequest: string,
    signal: AbortSignal
  ): Promise<void> {
    // Check for cancellation before starting
    if (signal.aborted) {
      throw new Error('AbortError');
    }

    // Step 1: Plan the task
    const planner = new TaskPlanner(this.apiKey, this.model);
    const plan = await planner.planTask(userRequest, {
      model: this.model,
      apiBaseUrl: this.apiBaseUrl,
    });

    console.log(`[LongTask] Plan created: ${plan.taskId}`);
    console.log(`[LongTask] Title: ${plan.title}`);
    console.log(`[LongTask] Subtasks: ${plan.totalSteps}`);

    // Check for cancellation after planning
    if (signal.aborted) {
      throw new Error('AbortError');
    }

    // Create initial state
    const state: LongTaskState = {
      plan,
      status: 'approved',
      currentStep: 0,
      results: new Map(),
      startedAt: new Date().toISOString(),
    };

    this.activeTasks.set(taskId, state);

    // Present plan to user
    const planMessage = this.formatPlanForUser(plan);
    await this.config.sendMessage(this.config.chatId, planMessage);

    // Persist plan using TaskTracker
    await this.taskTracker.saveLongTaskPlan(taskId, plan);

    // Create workspace directory for subtask execution
    const workspaceDir = await this.createWorkspace(plan.taskId);

    // Step 2: Execute subtasks sequentially
    state.status = 'executing';

    // Create executor with total steps info, apiBaseUrl, abort signal, and sendCard
    const executor = new SubtaskExecutor(this.apiKey, this.model, {
      ...this.config,
      totalSteps: plan.totalSteps,
      apiBaseUrl: this.apiBaseUrl,
      abortSignal: signal,
      sendCard: this.config.sendCard,
    });

    await this.executeSubtasks(state, workspaceDir, executor, signal);

    // Step 3: Generate final summary
    state.status = 'completed';
    state.completedAt = new Date().toISOString();
    await this.generateFinalSummary(state, workspaceDir);

    // Send completion message
    const finalMessage = this.formatCompletionMessage(state);
    await this.config.sendMessage(this.config.chatId, finalMessage);

    console.log(`[LongTask] Task ${plan.taskId} completed successfully`);
  }

  /**
   * Execute all subtasks in sequence.
   */
  private async executeSubtasks(
    state: LongTaskState,
    workspaceDir: string,
    executor: SubtaskExecutor,
    signal: AbortSignal
  ): Promise<void> {
    const { plan } = state;

    for (let i = 0; i < plan.subtasks.length; i++) {
      // Check for cancellation before each subtask
      if (signal.aborted) {
        console.log(`[LongTask] Task cancelled at step ${i + 1}/${plan.totalSteps}`);
        state.status = 'cancelled';
        throw new Error('AbortError');
      }

      state.currentStep = i + 1;

      const subtask = plan.subtasks[i];
      const previousResults = Array.from(this.activeTasks.values())
        .flatMap(s => Array.from(s.results.values()))
        .filter(r => r.sequence < subtask.sequence);

      console.log(`[LongTask] Executing step ${i + 1}/${plan.totalSteps}: ${subtask.title}`);

      // Execute subtask
      const result = await executor.executeSubtask(subtask, previousResults, workspaceDir);

      // Store result
      state.results.set(subtask.sequence, result);

      // Check if subtask failed
      if (!result.success) {
        console.error(`[LongTask] Subtask ${subtask.sequence} failed, stopping workflow`);
        state.status = 'failed';
        state.error = result.error || 'Unknown error';
        throw new Error(`Subtask ${subtask.sequence} failed: ${result.error}`);
      }

      // Persist result after each step using TaskTracker
      await this.taskTracker.saveSubtaskResult(plan.taskId, result);
    }
  }

  /**
   * Create workspace directory for the task.
   */
  private async createWorkspace(taskId: string): Promise<string> {
    // Fix: Ensure workspace subdirectory is used
    const baseDir = path.join(this.config.workspaceBaseDir, 'workspace', 'long-tasks');
    await fs.mkdir(baseDir, { recursive: true });

    const taskDir = path.join(baseDir, taskId);
    await fs.mkdir(taskDir, { recursive: true });

    console.log(`[LongTask] Created workspace: ${taskDir}`);
    return taskDir;
  }

  /**
   * Generate final summary for the entire task.
   */
  private async generateFinalSummary(state: LongTaskState, workspaceDir: string): Promise<void> {
    const { plan, results } = state;

    const content = `# Final Summary: ${plan.title}

**Task ID**: ${plan.taskId}
**Started**: ${state.startedAt}
**Completed**: ${state.completedAt}
**Status**: ${state.status}

## Original Request

${plan.originalRequest}

## Execution Summary

✅ **Completed Steps**: ${results.size} / ${plan.totalSteps}

## Step-by-Step Results

${Array.from(results.values()).map(r => `
### Step ${r.sequence}

**Status**: ${r.success ? '✅ Success' : '❌ Failed'}
**Completed**: ${r.completedAt}

${r.success ? `
**Summary File**: \`${r.summaryFile}\`

**Files Created**:
${r.files.length > 0 ? r.files.map(f => `- \`${f}\``).join('\n') : '(none)'}
` : `
**Error**: ${r.error || 'Unknown error'}
`}
`).join('\n---\n')}

## Key Outcomes

- Total subtasks executed: ${plan.totalSteps}
- Successful: ${Array.from(results.values()).filter(r => r.success).length}
- Failed: ${Array.from(results.values()).filter(r => !r.success).length}
- Total workspace: \`${workspaceDir}\`

## Next Steps

Review the generated files and summaries in each subtask directory for detailed results.

---

*Generated automatically by Long Task Manager*
`;

    // Save final summary using TaskTracker
    await this.taskTracker.saveLongTaskSummary(plan.taskId, content);
  }

  /**
   * Format plan for user display.
   */
  private formatPlanForUser(plan: LongTaskPlan): string {
    const lines = [
      '📋 **Task Plan Created**',
      '',
      `**Title**: ${plan.title}`,
      `**Description**: ${plan.description}`,
      '',
      `**Steps (${plan.totalSteps})**`,
      '',
    ];

    for (const subtask of plan.subtasks) {
      const complexityIcon =
        subtask.complexity === 'simple' ? '🟢' :
        subtask.complexity === 'complex' ? '🔴' : '🟡';

      lines.push(`${complexityIcon} **Step ${subtask.sequence}**: ${subtask.title}`);

      // Add markdown requirements if present
      if (subtask.outputs.markdownRequirements && subtask.outputs.markdownRequirements.length > 0) {
        const requiredSections = subtask.outputs.markdownRequirements
          .filter(r => r.required)
          .map(r => r.title)
          .join(', ');
        lines.push(`   📝 Required output: ${requiredSections}`);
      }

      // Show input dependencies
      if (subtask.inputs.sources && subtask.inputs.sources.length > 0) {
        lines.push(`   📥 Input: ${subtask.inputs.sources.slice(0, 2).join(', ')}${subtask.inputs.sources.length > 2 ? '...' : ''}`);
      }
    }

    lines.push('');
    lines.push('⏳ Starting execution...');
    lines.push('');
    lines.push('*(You will receive progress updates after each step)*');

    return lines.join('\n');
  }

  /**
   * Format completion message for user.
   */
  private formatCompletionMessage(state: LongTaskState): string {
    const { plan, results } = state;
    const successCount = Array.from(results.values()).filter(r => r.success).length;

    const lines = [
      '🎉 **Long Task Completed**',
      '',
      `**Title**: ${plan.title}`,
      `**Status**: ✅ All steps completed (${successCount}/${plan.totalSteps})`,
      '',
      `**Workspace**: \`workspace/long-tasks/${plan.taskId}\``,
      '',
      '**Generated Files**',
    ];

    for (const result of results.values()) {
      if (result.success && result.files.length > 0) {
        lines.push(`\nStep ${result.sequence} (${result.files.length} files):`);
        for (const file of result.files.slice(0, 5)) {
          lines.push(`  - \`${file}\``);
        }
        if (result.files.length > 5) {
          lines.push(`  - ... and ${result.files.length - 5} more`);
        }
      }
    }

    lines.push('');
    lines.push('📄 Check `FINAL_SUMMARY.md` in the workspace for complete results.');

    return lines.join('\n');
  }

  /**
   * Get status of an active task.
   */
  getTaskStatus(taskId: string): LongTaskState | undefined {
    return this.activeTasks.get(taskId);
  }

  /**
   * Get all active tasks.
   */
  getActiveTasks(): Map<string, LongTaskState> {
    return new Map(this.activeTasks);
  }

  /**
   * Cancel the active task for a chat.
   */
  async cancelTask(chatId: string): Promise<boolean> {
    // Find task by chat ID
    for (const [taskId, state] of this.activeTasks) {
      if (this.config.chatId === chatId && state.status === 'executing') {
        console.log(`[LongTask] Cancelling task ${taskId} for chat ${chatId}`);

        // Trigger abort
        if (this.config.abortSignal) {
          this.config.abortSignal.dispatchEvent(new Event('abort'));
        }

        state.status = 'cancelled';
        state.completedAt = new Date().toISOString();

        await this.config.sendMessage(
          chatId,
          '⚠️ **Task Cancelled**\n\nThe long task has been cancelled.'
        );

        return true;
      }
    }

    return false;
  }
}
