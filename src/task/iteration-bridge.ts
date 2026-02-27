/**
 * IterationBridge - Simplified Evaluator-Executor communication with REAL-TIME streaming.
 *
 * **Architecture (File-Driven - Direct Evaluator → Executor):**
 * - Phase 1: Evaluator evaluates task completion and writes evaluation.md
 * - Phase 2: If status=COMPLETE, Evaluator also writes final_result.md (ends loop)
 * - Phase 3: If final_result.md not present, Executor executes the task
 *
 * **Key Components:**
 * - **Evaluator** (Phase 1): Writes evaluation.md, and final_result.md if complete
 * - **Executor** (Phase 3): Reads evaluation.md, executes, writes execution.md
 *
 * **File-Driven Architecture:**
 * - No JSON parsing - all communication via markdown files
 * - No Planner layer - Executor executes tasks directly
 * - No subtask concept - Single task execution
 * - Completion detected via final_result.md presence (created by Evaluator)
 *
 * **Stream-Based Event Processing:**
 * - Executor events flow directly to Reporter via processEvent()
 * - All messages yielded immediately for real-time user feedback
 * - Simple yield* composition, no queue management
 */

import type { AgentMessage } from '../types/agent.js';
import { Evaluator, type EvaluatorConfig } from '../agents/evaluator.js';
import { Reporter } from '../agents/reporter.js';
import { Executor } from '../agents/executor.js';
import { createLogger } from '../utils/logger.js';
import { TaskFileManager } from './task-files.js';
import { Config } from '../config/index.js';

const logger = createLogger('IterationBridge');

/**
 * Configuration for IterationBridge.
 */
export interface IterationBridgeConfig {
  /** Evaluator configuration */
  evaluatorConfig: EvaluatorConfig;
  /** Current iteration number */
  iteration: number;
  /** Task ID for file management */
  taskId: string;
  /** Chat ID for user feedback (passed from DialogueOrchestrator) */
  chatId?: string;
}

/**
 * IterationBridge - Simplified Evaluator-Executor communication for a single iteration.
 *
 * File-driven architecture:
 * - Evaluator writes evaluation.md (always) and final_result.md (when COMPLETE)
 * - Executor reads evaluation.md and writes execution.md
 * - Completion detected by checking final_result.md existence after Evaluator phase
 */
export class IterationBridge {
  readonly evaluatorConfig: EvaluatorConfig;
  readonly iteration: number;
  readonly taskId: string;
  readonly chatId?: string;

  private fileManager: TaskFileManager;

  constructor(config: IterationBridgeConfig) {
    this.evaluatorConfig = config.evaluatorConfig;
    this.iteration = config.iteration;
    this.taskId = config.taskId;
    this.chatId = config.chatId;
    this.fileManager = new TaskFileManager();
  }

  /**
   * Run a single iteration with DIRECT Evaluator → Executor communication.
   */
  async *runIterationStreaming(): AsyncIterable<AgentMessage> {
    logger.info({
      iteration: this.iteration,
      taskId: this.taskId,
      chatId: this.chatId,
    }, 'Starting iteration (Evaluator → Executor)');

    // === Phase 1: Evaluation ===
    logger.info({
      iteration: this.iteration,
      taskId: this.taskId,
    }, 'Phase 1: Starting Evaluator');

    const evaluator = new Evaluator(this.evaluatorConfig);

    try {
      // Evaluator writes evaluation.md
      for await (const msg of evaluator.evaluate(this.taskId, this.iteration)) {
        yield msg;
      }

      logger.info({
        iteration: this.iteration,
        taskId: this.taskId,
      }, 'Phase 1 complete: Evaluator finished');
    } catch (error) {
      logger.error({
        err: error,
        iteration: this.iteration,
        taskId: this.taskId,
      }, 'Phase 1 failed: Evaluator error');
      throw error;
    } finally {
      evaluator.cleanup();
    }

    // Check if task is already complete (final_result.md exists)
    logger.debug({
      iteration: this.iteration,
      taskId: this.taskId,
    }, 'Checking for final_result.md');

    const hasFinalResult = await this.fileManager.hasFinalResult(this.taskId);

    if (hasFinalResult) {
      logger.info({
        iteration: this.iteration,
        taskId: this.taskId,
      }, 'Task complete (final_result.md detected) - skipping Executor phase');

      yield {
        content: '✅ Task completed - final result detected',
        role: 'assistant',
        messageType: 'task_completion',
        metadata: { status: 'complete' },
      };

      return;
    }

    // === Phase 2: Execution ===
    logger.info({
      iteration: this.iteration,
      taskId: this.taskId,
    }, 'Phase 2: Starting Executor (task not yet complete)');

    yield* this.executeTask();

    logger.info({
      iteration: this.iteration,
      taskId: this.taskId,
    }, 'Phase 2 complete: Executor finished');
  }

  /**
   * Execute task - reads evaluation.md and writes execution.md.
   *
   * Simplified architecture using Reporter.processEvent():
   * - Executor events flow directly to Reporter
   * - All messages yielded via simple yield* composition
   * - No queue management, no busy waiting
   */
  private async *executeTask(): AsyncIterable<AgentMessage> {
    logger.info({
      taskId: this.taskId,
      iteration: this.iteration,
    }, 'Starting task execution');

    yield {
      content: '⚡ **Executing Task**',
      role: 'assistant',
      messageType: 'status',
    };

    const agentConfig = Config.getAgentConfig();

    // Create Reporter
    const reporter = new Reporter({
      apiKey: agentConfig.apiKey,
      model: agentConfig.model,
      apiBaseUrl: agentConfig.apiBaseUrl,
      permissionMode: 'bypassPermissions',
    });

    // Reporter context for event processing
    const reporterContext = {
      taskId: this.taskId,
      iteration: this.iteration,
      chatId: this.chatId,
    };

    try {
      // Create Executor
      logger.debug({
        taskId: this.taskId,
        iteration: this.iteration,
      }, 'Creating Executor instance');

      const executor = new Executor({
        apiKey: agentConfig.apiKey,
        model: agentConfig.model,
        apiBaseUrl: agentConfig.apiBaseUrl,
        permissionMode: 'bypassPermissions',
      });

      // Get Executor event stream
      logger.info({
        taskId: this.taskId,
        iteration: this.iteration,
        workspaceDir: Config.getWorkspaceDir(),
      }, 'Starting Executor event stream');

      const executorStream = executor.executeTask(
        this.taskId,
        this.iteration,
        Config.getWorkspaceDir()
      );

      // Process all Executor events through Reporter
      let eventCount = 0;
      for await (const event of executorStream) {
        eventCount++;
        yield* reporter.processEvent(event, reporterContext);
      }

      logger.info({
        taskId: this.taskId,
        iteration: this.iteration,
        eventCount,
      }, 'Executor stream completed');

    } catch (error) {
      logger.error(
        { err: error, taskId: this.taskId, iteration: this.iteration },
        'Task execution failed'
      );

      yield {
        content: `❌ **Task execution failed**: ${error instanceof Error ? error.message : String(error)}`,
        role: 'assistant',
        messageType: 'error',
      };
    } finally {
      reporter.cleanup();
      logger.debug({
        taskId: this.taskId,
        iteration: this.iteration,
      }, 'Executor cleanup complete');
    }
  }

  /**
   * Get the Executor's output from the execution.md file.
   */
  async getExecutorOutput(): Promise<string> {
    try {
      return await this.fileManager.readExecution(this.taskId, this.iteration);
    } catch {
      return '';
    }
  }
}
