/**
 * Task Execution Service - Orchestrates complex task execution with complexity analysis.
 *
 * Issue #857: Complex Task Auto-Start Task Agent
 *
 * This service provides:
 * - Automatic task complexity detection
 * - Progress tracking and reporting
 * - Historical data learning for better estimates
 *
 * @module agents/task-execution-service
 */

import { createLogger } from '../utils/logger.js';
import {
  TaskComplexityAgent,
  createTaskComplexityAgent,
  type TaskComplexityResult,
  type TaskComplexityAgentConfig,
} from './task-complexity-agent.js';
import {
  TaskProgressService,
  createTaskProgressService,
} from './task-progress-service.js';
import { taskHistoryStorage } from './task-history.js';
import { Config } from '../config/index.js';

const logger = createLogger('TaskExecutionService');

/**
 * Callbacks for task execution service.
 */
export interface TaskExecutionCallbacks {
  /** Send a text message */
  sendMessage: (chatId: string, text: string, threadId?: string) => Promise<void>;
  /** Send an interactive card */
  sendCard: (chatId: string, card: Record<string, unknown>, description?: string, threadId?: string) => Promise<void>;
  /** Update an existing card */
  updateCard?: (cardId: string, card: Record<string, unknown>) => Promise<void>;
  /** Get channel capabilities */
  getCapabilities?: (chatId: string) => {
    supportedMcpTools?: string[];
    supportsCard?: boolean;
  } | undefined;
}

/**
 * Task execution context.
 */
export interface TaskExecutionContext {
  chatId: string;
  messageId: string;
  threadId?: string;
  userMessage: string;
  senderOpenId?: string;
}

/**
 * Options for task execution service.
 */
export interface TaskExecutionServiceOptions {
  /** Complexity threshold for starting progress tracking (default: 7) */
  complexityThreshold?: number;
  /** Minimum estimated time (seconds) to show progress (default: 60) */
  minEstimatedTimeForProgress?: number;
  /** Enable/disable progress reporting (default: true) */
  enableProgressReporting?: boolean;
}

/**
 * Result of task analysis.
 */
export interface TaskAnalysisResult {
  /** Whether this task needs progress tracking */
  needsProgressTracking: boolean;
  /** Complexity analysis result */
  complexity: TaskComplexityResult;
  /** Progress service instance (if needsProgressTracking) */
  progressService?: TaskProgressService;
}

/**
 * Task Execution Service.
 *
 * Analyzes task complexity and provides progress tracking for complex tasks.
 *
 * @example
 * ```typescript
 * const service = new TaskExecutionService(callbacks, options);
 *
 * // Analyze a task
 * const analysis = await service.analyzeTask({
 *   chatId: 'chat-123',
 *   messageId: 'msg-456',
 *   userMessage: 'Refactor the authentication module',
 * });
 *
 * if (analysis.needsProgressTracking) {
 *   // Start progress tracking
 *   await analysis.progressService?.start(analysis.complexity);
 *
 *   // During execution, update progress
 *   await analysis.progressService?.update('Analyzing code...', 1, 5);
 *
 *   // On completion
 *   await analysis.progressService?.complete(true, 'Refactoring completed');
 * }
 * ```
 */
export class TaskExecutionService {
  private readonly complexityAgent: TaskComplexityAgent;
  private readonly callbacks: TaskExecutionCallbacks;
  private readonly options: Required<TaskExecutionServiceOptions>;

  /** Active progress services by chatId */
  private activeProgressServices = new Map<string, TaskProgressService>();

  constructor(
    callbacks: TaskExecutionCallbacks,
    options: TaskExecutionServiceOptions = {}
  ) {
    this.callbacks = callbacks;
    this.options = {
      complexityThreshold: options.complexityThreshold ?? 7,
      minEstimatedTimeForProgress: options.minEstimatedTimeForProgress ?? 60,
      enableProgressReporting: options.enableProgressReporting ?? true,
    };

    // Create complexity agent
    const agentConfig: TaskComplexityAgentConfig = {
      ...Config.getAgentConfig(),
      complexityThreshold: this.options.complexityThreshold,
    };
    this.complexityAgent = createTaskComplexityAgent(agentConfig);

    // Initialize task history storage
    taskHistoryStorage.initialize().catch(err => {
      logger.error({ err }, 'Failed to initialize task history storage');
    });

    logger.info({
      complexityThreshold: this.options.complexityThreshold,
      minEstimatedTimeForProgress: this.options.minEstimatedTimeForProgress,
    }, 'TaskExecutionService initialized');
  }

  /**
   * Analyze a task to determine complexity and whether progress tracking is needed.
   *
   * This method:
   * 1. Uses LLM-based complexity analysis
   * 2. References historical data for better estimates
   * 3. Creates progress service if needed
   *
   * @param context - Task execution context
   * @returns Analysis result with complexity and optional progress service
   */
  async analyzeTask(context: TaskExecutionContext): Promise<TaskAnalysisResult> {
    const { chatId, messageId, userMessage } = context;

    logger.info({
      chatId,
      messageId,
      messageLength: userMessage.length,
    }, 'Analyzing task complexity');

    try {
      // Analyze complexity using LLM
      const complexity = await this.complexityAgent.analyze({
        chatId,
        messageId,
        userMessage,
      });

      logger.info({
        chatId,
        messageId,
        complexityScore: complexity.complexityScore,
        complexityLevel: complexity.complexityLevel,
        estimatedSeconds: complexity.estimatedSeconds,
        shouldStartTaskAgent: complexity.recommendation.shouldStartTaskAgent,
      }, 'Task complexity analysis complete');

      // Determine if progress tracking is needed
      const needsProgressTracking = this.shouldTrackProgress(complexity);

      if (needsProgressTracking && this.options.enableProgressReporting) {
        // Create progress service
        const progressService = createTaskProgressService({
          chatId,
          threadId: context.threadId,
          taskDescription: this.extractTaskDescription(userMessage),
          estimatedSeconds: complexity.estimatedSeconds,
          sendCard: this.callbacks.sendCard,
          updateCard: this.callbacks.updateCard,
        });

        // Store for later reference
        this.activeProgressServices.set(chatId, progressService);

        return {
          needsProgressTracking: true,
          complexity,
          progressService,
        };
      }

      return {
        needsProgressTracking: false,
        complexity,
      };
    } catch (error) {
      logger.error({
        err: error,
        chatId,
        messageId,
      }, 'Task complexity analysis failed');

      // Return default result on error
      return {
        needsProgressTracking: false,
        complexity: this.getDefaultComplexity(),
      };
    }
  }

  /**
   * Get the active progress service for a chat.
   */
  getProgressService(chatId: string): TaskProgressService | undefined {
    return this.activeProgressServices.get(chatId);
  }

  /**
   * Complete and clean up progress tracking for a chat.
   *
   * @param chatId - Chat ID
   * @param success - Whether the task succeeded
   * @param summary - Optional summary of the completed task
   * @param context - Original task context for history recording
   * @param complexity - Original complexity analysis for history recording
   */
  async completeTask(
    chatId: string,
    success: boolean,
    summary?: string,
    context?: TaskExecutionContext,
    complexity?: TaskComplexityResult
  ): Promise<void> {
    const progressService = this.activeProgressServices.get(chatId);

    if (progressService) {
      await progressService.complete(success, summary);

      // Record to history if we have the context
      if (context && complexity) {
        const taskId = `task-${chatId}-${Date.now()}`;
        await progressService.recordToHistory(
          taskId,
          context.userMessage,
          complexity,
          success
        );
      }

      // Clean up
      this.activeProgressServices.delete(chatId);
    }
  }

  /**
   * Update progress for an active task.
   */
  async updateProgress(
    chatId: string,
    activity: string,
    step?: number,
    totalSteps?: number
  ): Promise<void> {
    const progressService = this.activeProgressServices.get(chatId);
    if (progressService) {
      await progressService.update(activity, step, totalSteps);
    }
  }

  /**
   * Check if a task needs progress tracking.
   */
  private shouldTrackProgress(complexity: TaskComplexityResult): boolean {
    // Check complexity threshold
    if (complexity.complexityScore < this.options.complexityThreshold) {
      return false;
    }

    // Check minimum estimated time
    if (complexity.estimatedSeconds < this.options.minEstimatedTimeForProgress) {
      return false;
    }

    // Check recommendation
    return complexity.recommendation.shouldStartTaskAgent;
  }

  /**
   * Extract a brief task description from user message.
   */
  private extractTaskDescription(message: string): string {
    // Take first 50 characters as description
    if (message.length <= 50) {
      return message;
    }

    // Try to find a natural break point
    const breakPoints = ['\n', '。', '.', '！', '!', '？', '?'];
    for (const bp of breakPoints) {
      const idx = message.indexOf(bp);
      if (idx > 20 && idx < 100) {
        return message.slice(0, idx + 1);
      }
    }

    // Fallback: truncate with ellipsis
    return message.slice(0, 47) + '...';
  }

  /**
   * Get default complexity result for error cases.
   */
  private getDefaultComplexity(): TaskComplexityResult {
    return {
      complexityScore: 5,
      complexityLevel: 'medium',
      estimatedSteps: 3,
      estimatedSeconds: 120,
      confidence: 0.3,
      reasoning: {
        taskType: 'general',
        scope: 'unknown',
        uncertainty: 'high',
        dependencies: [],
        keyFactors: ['Analysis failed, using default values'],
      },
      recommendation: {
        shouldStartTaskAgent: false,
        reportingInterval: 0,
        message: '',
      },
    };
  }

  /**
   * Get statistics about task history.
   */
  async getHistoryStats(): Promise<{
    historyCount: number;
    statsCount: number;
    reliableTaskTypes: string[];
  }> {
    const stats = taskHistoryStorage.getStats();
    const reliableTaskTypes = await taskHistoryStorage.getReliableTaskTypes();

    return {
      historyCount: stats.historyCount,
      statsCount: stats.statsCount,
      reliableTaskTypes,
    };
  }
}

/**
 * Create a TaskExecutionService instance.
 */
export function createTaskExecutionService(
  callbacks: TaskExecutionCallbacks,
  options?: TaskExecutionServiceOptions
): TaskExecutionService {
  return new TaskExecutionService(callbacks, options);
}
