/**
 * Skill Worker Agent - A worker that wraps a SkillAgent.
 *
 * This module provides a WorkerAgent implementation that uses
 * the existing SkillAgent infrastructure.
 *
 * @module agents/worker-pool/skill-worker-agent
 */

import { createLogger } from '../../utils/logger.js';
import type { SkillAgent } from '../types.js';
import type {
  WorkerAgent,
  WorkerConfig,
  WorkerStats,
  WorkerStatus,
  SubTask,
  SubTaskResult,
} from './types.js';

const logger = createLogger('SkillWorkerAgent');

/**
 * Factory function type for creating SkillAgents.
 */
export type SkillAgentFactory = () => SkillAgent;

/**
 * SkillWorkerAgent - A worker that wraps a SkillAgent.
 *
 * This implementation allows existing SkillAgent implementations
 * (Evaluator, Executor, etc.) to be used as workers in the pool.
 *
 * @example
 * ```typescript
 * const worker = new SkillWorkerAgent(
 *   { id: 'worker-1' },
 *   () => new Evaluator(config)
 * );
 *
 * const result = await worker.execute({
 *   id: 'task-1',
 *   description: 'Evaluate task',
 *   input: 'Please evaluate...',
 * });
 *
 * worker.dispose();
 * ```
 */
export class SkillWorkerAgent implements WorkerAgent {
  readonly id: string;
  readonly type: string;

  private readonly skillAgentFactory: SkillAgentFactory;
  private readonly defaultTimeout: number;
  private skillAgent: SkillAgent | null = null;
  private _status: WorkerStatus = 'idle';
  private disposed = false;

  // Statistics
  private tasksCompleted = 0;
  private tasksFailed = 0;
  private totalExecutionTime = 0;

  constructor(config: WorkerConfig, skillAgentFactory: SkillAgentFactory) {
    this.id = config.id;
    this.type = config.type ?? 'skill';
    this.defaultTimeout = config.defaultTimeout ?? 60000;
    this.skillAgentFactory = skillAgentFactory;

    logger.debug({ workerId: this.id }, 'SkillWorkerAgent created');
  }

  /**
   * Get current worker status.
   */
  get status(): WorkerStatus {
    return this._status;
  }

  /**
   * Get worker statistics.
   */
  get stats(): WorkerStats {
    return {
      id: this.id,
      status: this.status,
      tasksCompleted: this.tasksCompleted,
      tasksFailed: this.tasksFailed,
      totalExecutionTime: this.totalExecutionTime,
      averageExecutionTime:
        this.tasksCompleted + this.tasksFailed > 0
          ? this.totalExecutionTime / (this.tasksCompleted + this.tasksFailed)
          : 0,
    };
  }

  /**
   * Execute a subtask.
   *
   * @param task - The subtask to execute
   * @returns Promise resolving to the task result
   */
  async execute(task: SubTask): Promise<SubTaskResult> {
    if (this.disposed) {
      return {
        taskId: task.id,
        status: 'failed',
        error: 'Worker has been disposed',
      };
    }

    this._status = 'busy';
    const startTime = Date.now();

    logger.debug({ workerId: this.id, taskId: task.id }, 'Starting task execution');

    try {
      // Create or reuse skill agent
      if (!this.skillAgent) {
        this.skillAgent = this.skillAgentFactory();
      }

      // Execute with timeout
      const timeout = task.timeout ?? this.defaultTimeout;
      const messages: import('../../types/agent.js').AgentMessage[] = [];

      // Collect messages from execution
      const executePromise = async () => {
        for await (const message of this.skillAgent!.execute(task.input)) {
          messages.push(message);
        }
        // Get the final content from the last message
        const lastMessage = messages[messages.length - 1];
        const rawContent = lastMessage?.content;

        // Convert ContentBlock[] to string if needed
        if (typeof rawContent === 'string') {
          return rawContent;
        }
        if (Array.isArray(rawContent)) {
          // Extract text from ContentBlock[], join multiple text blocks
          return rawContent
            .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n');
        }
        return '';
      };

      const content = await this.withTimeout(executePromise(), timeout);

      const duration = Date.now() - startTime;
      this.tasksCompleted++;
      this.totalExecutionTime += duration;
      this._status = 'idle';

      logger.debug(
        { workerId: this.id, taskId: task.id, duration },
        'Task completed successfully'
      );

      return {
        taskId: task.id,
        status: 'completed',
        content,
        messages,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.tasksFailed++;
      this.totalExecutionTime += duration;

      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if it was a timeout
      if (error instanceof Error && error.message === 'Task timed out') {
        this._status = 'error';
        logger.warn(
          { workerId: this.id, taskId: task.id, timeout: task.timeout ?? this.defaultTimeout },
          'Task timed out'
        );

        return {
          taskId: task.id,
          status: 'failed',
          error: `Task timed out after ${task.timeout ?? this.defaultTimeout}ms`,
          duration,
        };
      }

      this._status = 'idle';
      logger.error(
        { error: errorMessage, workerId: this.id, taskId: task.id },
        'Task failed'
      );

      return {
        taskId: task.id,
        status: 'failed',
        error: errorMessage,
        duration,
      };
    }
  }

  /**
   * Check if the worker is available for new tasks.
   */
  isAvailable(): boolean {
    return !this.disposed && this.status === 'idle';
  }

  /**
   * Dispose of the worker and its resources.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this._status = 'disposed';

    if (this.skillAgent) {
      try {
        this.skillAgent.dispose();
      } catch (error) {
        logger.error({ error, workerId: this.id }, 'Error disposing skill agent');
      }
      this.skillAgent = null;
    }

    logger.debug({ workerId: this.id }, 'SkillWorkerAgent disposed');
  }

  /**
   * Wrap a promise with a timeout.
   */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Task timed out'));
      }, timeoutMs);

      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }
}
