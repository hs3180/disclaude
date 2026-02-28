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
 *
 * **Observability (Issue #271 Phase 3):**
 * - Tracks metrics for each phase (duration, event counts)
 * - Emits events for external monitoring
 * - Provides iteration-level statistics
 *
 * @module task/iteration-bridge
 */

import type { AgentMessage } from '../types/agent.js';
import { Evaluator, type EvaluatorConfig } from '../agents/evaluator.js';
import { Reporter } from '../agents/reporter.js';
import { Executor } from '../agents/executor.js';
import { createLogger } from '../utils/logger.js';
import { TaskFileManager } from './task-files.js';
import { Config } from '../config/index.js';

const logger = createLogger('IterationBridge');

// ============================================================================
// Observability Types (Issue #271 Phase 3)
// ============================================================================

/**
 * Metrics for a single iteration phase.
 */
export interface PhaseMetrics {
  /** Phase name */
  phase: 'evaluate' | 'execute';
  /** Start timestamp */
  startTime: Date;
  /** End timestamp */
  endTime?: Date;
  /** Duration in milliseconds */
  durationMs?: number;
  /** Number of messages yielded */
  messageCount: number;
  /** Whether the phase failed */
  failed: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Metrics for a complete iteration.
 */
export interface IterationMetrics {
  /** Task ID */
  taskId: string;
  /** Iteration number */
  iteration: number;
  /** Start timestamp */
  startTime: Date;
  /** End timestamp */
  endTime?: Date;
  /** Total duration in milliseconds */
  totalDurationMs?: number;
  /** Phase-specific metrics */
  phases: {
    evaluate: PhaseMetrics;
    execute?: PhaseMetrics;
  };
  /** Whether task is complete */
  taskComplete: boolean;
  /** Total messages yielded */
  totalMessages: number;
}

/**
 * Event emitted during iteration for observability.
 */
export interface IterationEvent {
  /** Event type */
  type: 'iteration_start' | 'iteration_end' | 'phase_start' | 'phase_end' | 'error';
  /** Task ID */
  taskId: string;
  /** Iteration number */
  iteration: number;
  /** Timestamp */
  timestamp: Date;
  /** Event-specific data */
  data?: Record<string, unknown>;
}

/**
 * Event handler type for observability.
 */
export type IterationEventHandler = (event: IterationEvent) => void;

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
  /** Event handler for observability (Issue #271 Phase 3) */
  onEvent?: IterationEventHandler;
  /** Whether to enable metrics collection (default: true) */
  enableMetrics?: boolean;
}

/**
 * IterationBridge - Simplified Evaluator-Executor communication for a single iteration.
 *
 * File-driven architecture:
 * - Evaluator writes evaluation.md (always) and final_result.md (when COMPLETE)
 * - Executor reads evaluation.md and writes execution.md
 * - Completion detected by checking final_result.md existence after Evaluator phase
 *
 * Observability features (Issue #271 Phase 3):
 * - Tracks phase durations and message counts
 * - Emits events for external monitoring
 * - Provides getMetrics() for iteration statistics
 */
export class IterationBridge {
  readonly evaluatorConfig: EvaluatorConfig;
  readonly iteration: number;
  readonly taskId: string;
  readonly chatId?: string;

  private fileManager: TaskFileManager;
  private readonly onEvent?: IterationEventHandler;
  private readonly enableMetrics: boolean;
  private metrics?: IterationMetrics;

  constructor(config: IterationBridgeConfig) {
    this.evaluatorConfig = config.evaluatorConfig;
    this.iteration = config.iteration;
    this.taskId = config.taskId;
    this.chatId = config.chatId;
    this.fileManager = new TaskFileManager();
    this.onEvent = config.onEvent;
    this.enableMetrics = config.enableMetrics ?? true;
  }

  /**
   * Emit an event for observability.
   */
  private emitEvent(
    type: IterationEvent['type'],
    data?: Record<string, unknown>
  ): void {
    if (this.onEvent) {
      this.onEvent({
        type,
        taskId: this.taskId,
        iteration: this.iteration,
        timestamp: new Date(),
        data,
      });
    }
  }

  /**
   * Initialize metrics tracking for this iteration.
   */
  private initMetrics(): void {
    if (!this.enableMetrics) return;

    this.metrics = {
      taskId: this.taskId,
      iteration: this.iteration,
      startTime: new Date(),
      phases: {
        evaluate: {
          phase: 'evaluate',
          startTime: new Date(),
          messageCount: 0,
          failed: false,
        },
      },
      taskComplete: false,
      totalMessages: 0,
    };
  }

  /**
   * Get current iteration metrics.
   */
  getMetrics(): IterationMetrics | undefined {
    return this.metrics ? { ...this.metrics } : undefined;
  }

  /**
   * Run a single iteration with DIRECT Evaluator → Executor communication.
   *
   * Includes observability tracking (Issue #271 Phase 3):
   * - Emits iteration_start/iteration_end events
   * - Tracks phase durations and message counts
   * - Provides metrics via getMetrics()
   */
  async *runIterationStreaming(): AsyncIterable<AgentMessage> {
    logger.info({
      iteration: this.iteration,
      taskId: this.taskId,
      chatId: this.chatId,
    }, 'Starting iteration (Evaluator → Executor)');

    // Initialize metrics and emit start event
    this.initMetrics();
    this.emitEvent('iteration_start', { chatId: this.chatId });

    // === Phase 1: Evaluation ===
    this.emitEvent('phase_start', { phase: 'evaluate' });
    const evaluateStart = Date.now();
    let evaluateMessageCount = 0;

    logger.info({
      iteration: this.iteration,
      taskId: this.taskId,
    }, 'Phase 1: Starting Evaluator');

    const evaluator = new Evaluator(this.evaluatorConfig);

    try {
      // Evaluator writes evaluation.md
      for await (const msg of evaluator.evaluate(this.taskId, this.iteration)) {
        evaluateMessageCount++;
        if (this.metrics) {
          this.metrics.phases.evaluate.messageCount++;
          this.metrics.totalMessages++;
        }
        yield msg;
      }

      const evaluateDuration = Date.now() - evaluateStart;
      if (this.metrics) {
        this.metrics.phases.evaluate.endTime = new Date();
        this.metrics.phases.evaluate.durationMs = evaluateDuration;
      }

      this.emitEvent('phase_end', {
        phase: 'evaluate',
        durationMs: evaluateDuration,
        messageCount: evaluateMessageCount,
      });

      logger.info({
        iteration: this.iteration,
        taskId: this.taskId,
        durationMs: evaluateDuration,
        messageCount: evaluateMessageCount,
      }, 'Phase 1 complete: Evaluator finished');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (this.metrics) {
        this.metrics.phases.evaluate.failed = true;
        this.metrics.phases.evaluate.error = errorMsg;
        this.metrics.phases.evaluate.endTime = new Date();
        this.metrics.phases.evaluate.durationMs = Date.now() - evaluateStart;
      }

      this.emitEvent('error', { phase: 'evaluate', error: errorMsg });
      logger.error({
        err: error,
        iteration: this.iteration,
        taskId: this.taskId,
      }, 'Phase 1 failed: Evaluator error');
      throw error;
    } finally {
      evaluator.dispose();
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

      // Update metrics for completion
      if (this.metrics) {
        this.metrics.taskComplete = true;
        this.metrics.endTime = new Date();
        this.metrics.totalDurationMs = Date.now() - this.metrics.startTime.getTime();
      }

      this.emitEvent('iteration_end', {
        taskComplete: true,
        skippedPhases: ['execute'],
      });

      yield {
        content: '✅ Task completed - final result detected',
        role: 'assistant',
        messageType: 'task_completion',
        metadata: { status: 'complete' },
      };

      return;
    }

    // === Phase 2: Execution ===
    this.emitEvent('phase_start', { phase: 'execute' });
    const executeStart = Date.now();

    logger.info({
      iteration: this.iteration,
      taskId: this.taskId,
    }, 'Phase 2: Starting Executor (task not yet complete)');

    // Initialize execute phase metrics
    if (this.metrics) {
      this.metrics.phases.execute = {
        phase: 'execute',
        startTime: new Date(),
        messageCount: 0,
        failed: false,
      };
    }

    let executeMessageCount = 0;
    try {
      for await (const msg of this.executeTask()) {
        executeMessageCount++;
        if (this.metrics && this.metrics.phases.execute) {
          this.metrics.phases.execute.messageCount++;
          this.metrics.totalMessages++;
        }
        yield msg;
      }

      const executeDuration = Date.now() - executeStart;
      if (this.metrics && this.metrics.phases.execute) {
        this.metrics.phases.execute.endTime = new Date();
        this.metrics.phases.execute.durationMs = executeDuration;
      }

      this.emitEvent('phase_end', {
        phase: 'execute',
        durationMs: executeDuration,
        messageCount: executeMessageCount,
      });

      logger.info({
        iteration: this.iteration,
        taskId: this.taskId,
        durationMs: executeDuration,
        messageCount: executeMessageCount,
      }, 'Phase 2 complete: Executor finished');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (this.metrics && this.metrics.phases.execute) {
        this.metrics.phases.execute.failed = true;
        this.metrics.phases.execute.error = errorMsg;
        this.metrics.phases.execute.endTime = new Date();
        this.metrics.phases.execute.durationMs = Date.now() - executeStart;
      }

      this.emitEvent('error', { phase: 'execute', error: errorMsg });
      logger.error({
        err: error,
        taskId: this.taskId,
        iteration: this.iteration,
      }, 'Phase 2 failed: Executor error');
      // Don't rethrow - allow iteration to complete with error status
    }

    // Finalize metrics
    if (this.metrics) {
      this.metrics.endTime = new Date();
      this.metrics.totalDurationMs = Date.now() - this.metrics.startTime.getTime();
    }

    this.emitEvent('iteration_end', {
      taskComplete: false,
      totalMessages: this.metrics?.totalMessages,
    });
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
      reporter.dispose();
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
