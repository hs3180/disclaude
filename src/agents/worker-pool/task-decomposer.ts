/**
 * Task Decomposer - Decomposes complex tasks into subtasks.
 *
 * Issue #897 Phase 2: Master-Workers multi-agent collaboration pattern.
 *
 * Features:
 * - Task decomposition strategies
 * - Subtask generation
 * - Dependency inference
 * - Parallelism analysis
 *
 * @module agents/worker-pool/task-decomposer
 */

import { createLogger } from '../../utils/logger.js';
import type { TaskOptions, TaskPriority, TaskDependency } from './types.js';

const logger = createLogger('TaskDecomposer');

// ============================================================================
// Decomposition Types
// ============================================================================

/**
 * Strategy for decomposing tasks.
 */
export type DecompositionStrategy =
  | 'parallel'     // Split into parallel subtasks
  | 'sequential'   // Split into sequential subtasks
  | 'hybrid';      // Mix of parallel and sequential

/**
 * Options for task decomposition.
 */
export interface DecompositionOptions {
  /** Parent task ID prefix */
  parentTaskId: string;
  /** Chat ID for subtasks */
  chatId: string;
  /** Callbacks for subtasks */
  callbacks: TaskOptions['callbacks'];
  /** Sender OpenId for context */
  senderOpenId?: string;
  /** Strategy for decomposition */
  strategy?: DecompositionStrategy;
  /** Default priority for subtasks */
  defaultPriority?: TaskPriority;
  /** Default timeout for subtasks */
  defaultTimeout?: number;
  /** Maximum parallelism */
  maxParallelism?: number;
}

/**
 * Definition of a subtask.
 */
export interface SubtaskDefinition {
  /** Subtask ID (relative) */
  id: string;
  /** Human-readable name */
  name: string;
  /** Task description/prompt */
  prompt: string;
  /** Priority (optional) */
  priority?: TaskPriority;
  /** Dependencies on other subtasks (by relative ID) */
  dependsOn?: string[];
  /** Estimated complexity (1-10) */
  complexity?: number;
  /** Metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Result of task decomposition.
 */
export interface DecompositionResult {
  /** Generated subtask options */
  subtasks: TaskOptions[];
  /** Execution plan */
  executionPlan: ExecutionPlan;
  /** Decomposition metadata */
  metadata: {
    strategy: DecompositionStrategy;
    totalSubtasks: number;
    maxDepth: number;
    estimatedParallelism: number;
  };
}

/**
 * Execution plan for decomposed tasks.
 */
export interface ExecutionPlan {
  /** Waves of tasks to execute (parallel within wave) */
  waves: TaskOptions[][];
  /** Total number of waves */
  totalWaves: number;
  /** Critical path (longest dependency chain) */
  criticalPath: string[];
  /** Maximum parallelism possible */
  maxParallelism: number;
}

// ============================================================================
// Task Decomposer Implementation
// ============================================================================

/**
 * Decomposes complex tasks into manageable subtasks.
 *
 * @example
 * ```typescript
 * const decomposer = new TaskDecomposer();
 *
 * // Define subtasks manually
 * const result = decomposer.decompose({
 *   parentTaskId: 'analyze-project',
 *   chatId: 'chat-123',
 *   callbacks: { ... },
 *   subtasks: [
 *     { id: 'read-config', name: 'Read Config', prompt: '...' },
 *     { id: 'analyze-src', name: 'Analyze Source', prompt: '...', dependsOn: ['read-config'] },
 *     { id: 'generate-report', name: 'Generate Report', prompt: '...', dependsOn: ['analyze-src'] },
 *   ],
 * });
 * ```
 */
export class TaskDecomposer {
  /**
   * Decompose a task based on provided subtask definitions.
   *
   * @param options - Decomposition options
   * @param subtaskDefs - Subtask definitions
   * @returns Decomposition result with execution plan
   */
  decompose(
    options: DecompositionOptions,
    subtaskDefs: SubtaskDefinition[]
  ): DecompositionResult {
    const strategy = options.strategy ?? 'hybrid';
    const defaultPriority = options.defaultPriority ?? 'normal';
    const defaultTimeout = options.defaultTimeout ?? 300000;

    // Convert subtask definitions to TaskOptions
    const subtasks: TaskOptions[] = subtaskDefs.map(def => ({
      id: `${options.parentTaskId}-${def.id}`,
      name: def.name,
      prompt: def.prompt,
      chatId: options.chatId,
      callbacks: options.callbacks,
      priority: def.priority ?? defaultPriority,
      timeout: defaultTimeout,
      senderOpenId: options.senderOpenId,
      dependencies: this.buildDependencies(def.dependsOn, options.parentTaskId),
      metadata: {
        ...def.metadata,
        parentId: options.parentTaskId,
        complexity: def.complexity,
      },
    }));

    // Build execution plan
    const executionPlan = this.buildExecutionPlan(subtasks, subtaskDefs);

    logger.info({
      parentId: options.parentTaskId,
      subtaskCount: subtasks.length,
      waves: executionPlan.totalWaves,
    }, 'Task decomposed');

    return {
      subtasks,
      executionPlan,
      metadata: {
        strategy,
        totalSubtasks: subtasks.length,
        maxDepth: executionPlan.totalWaves,
        estimatedParallelism: executionPlan.maxParallelism,
      },
    };
  }

  /**
   * Decompose a task for parallel file analysis.
   *
   * @param options - Decomposition options
   * @param filePaths - File paths to analyze
   * @param analysisPrompt - Prompt template for analysis
   * @returns Decomposition result
   */
  decomposeForFileAnalysis(
    options: DecompositionOptions,
    filePaths: string[],
    analysisPrompt: string
  ): DecompositionResult {
    const subtaskDefs: SubtaskDefinition[] = filePaths.map((filePath, index) => ({
      id: `analyze-${index}`,
      name: `Analyze ${filePath}`,
      prompt: analysisPrompt.replace('{file}', filePath),
      complexity: 3,
      metadata: { filePath },
    }));

    return this.decompose({ ...options, strategy: 'parallel' }, subtaskDefs);
  }

  /**
   * Decompose a task for multi-source search.
   *
   * @param options - Decomposition options
   * @param sources - Data sources to search
   * @param searchQuery - Search query
   * @returns Decomposition result
   */
  decomposeForMultiSourceSearch(
    options: DecompositionOptions,
    sources: string[],
    searchQuery: string
  ): DecompositionResult {
    const subtaskDefs: SubtaskDefinition[] = sources.map((source, index) => ({
      id: `search-${index}`,
      name: `Search ${source}`,
      prompt: `Search "${searchQuery}" in ${source}`,
      complexity: 2,
      metadata: { source },
    }));

    // Add aggregation task
    subtaskDefs.push({
      id: 'aggregate',
      name: 'Aggregate Results',
      prompt: `Aggregate and summarize search results for "${searchQuery}" from all sources`,
      dependsOn: sources.map((_, i) => `search-${i}`),
      complexity: 4,
    });

    return this.decompose({ ...options, strategy: 'hybrid' }, subtaskDefs);
  }

  /**
   * Decompose a sequential pipeline task.
   *
   * @param options - Decomposition options
   * @param stages - Pipeline stages
   * @returns Decomposition result
   */
  decomposePipeline(
    options: DecompositionOptions,
    stages: Array<{ id: string; name: string; prompt: string }>
  ): DecompositionResult {
    const subtaskDefs: SubtaskDefinition[] = stages.map((stage, index) => ({
      id: stage.id,
      name: stage.name,
      prompt: stage.prompt,
      dependsOn: index > 0 ? [stages[index - 1].id] : undefined,
      complexity: 5,
    }));

    return this.decompose({ ...options, strategy: 'sequential' }, subtaskDefs);
  }

  // --------------------------------------------------------------------------
  // Private Helpers
  // --------------------------------------------------------------------------

  /**
   * Build dependency references from relative IDs.
   */
  private buildDependencies(
    dependsOn: string[] | undefined,
    parentTaskId: string
  ): TaskDependency[] {
    if (!dependsOn || dependsOn.length === 0) {
      return [];
    }

    return dependsOn.map(depId => ({
      taskId: `${parentTaskId}-${depId}`,
      type: 'sequential' as const,
    }));
  }

  /**
   * Build execution plan from tasks and definitions.
   */
  private buildExecutionPlan(
    subtasks: TaskOptions[],
    _subtaskDefs: SubtaskDefinition[]
  ): ExecutionPlan {
    // Build dependency map using the already-built dependencies in TaskOptions
    const depMap = new Map<string, Set<string>>();
    const taskMap = new Map<string, TaskOptions>();

    for (let i = 0; i < subtasks.length; i++) {
      const task = subtasks[i];
      taskMap.set(task.id, task);

      const deps = new Set<string>();
      if (task.dependencies) {
        for (const dep of task.dependencies) {
          deps.add(dep.taskId);
        }
      }
      depMap.set(task.id, deps);
    }

    // Calculate waves using topological sort
    const waves: TaskOptions[][] = [];
    const completed = new Set<string>();
    const criticalPath: string[] = [];

    while (completed.size < subtasks.length) {
      const wave: TaskOptions[] = [];

      for (const task of subtasks) {
        if (completed.has(task.id)) {
          continue;
        }

        const deps = depMap.get(task.id) ?? new Set();
        const allDepsComplete = Array.from(deps).every(dep => completed.has(dep));

        if (allDepsComplete) {
          wave.push(task);
        }
      }

      if (wave.length === 0) {
        // Circular dependency detected
        logger.warn('Circular dependency detected in task decomposition');
        break;
      }

      waves.push(wave);
      for (const task of wave) {
        completed.add(task.id);
      }
    }

    // Calculate critical path (longest path through DAG)
    const pathLengths = new Map<string, number>();
    const calculatePathLength = (taskId: string): number => {
      const cachedLength = pathLengths.get(taskId);
      if (cachedLength !== undefined) {
        return cachedLength;
      }

      const deps = depMap.get(taskId) ?? new Set();
      if (deps.size === 0) {
        pathLengths.set(taskId, 1);
        return 1;
      }

      const maxDepLength = Math.max(
        ...Array.from(deps).map(dep => calculatePathLength(dep))
      );
      const length = maxDepLength + 1;
      pathLengths.set(taskId, length);
      return length;
    };

    for (const task of subtasks) {
      calculatePathLength(task.id);
    }

    // Build critical path
    let currentMax = 0;
    let currentTask = '';
    for (const [taskId, length] of pathLengths) {
      if (length > currentMax) {
        currentMax = length;
        currentTask = taskId;
      }
    }

    // Trace back critical path
    while (currentTask) {
      criticalPath.unshift(currentTask);
      const deps = depMap.get(currentTask) ?? new Set();
      let nextTask = '';
      let nextLength = 0;
      for (const dep of deps) {
        const depLength = pathLengths.get(dep) ?? 0;
        if (depLength > nextLength) {
          nextLength = depLength;
          nextTask = dep;
        }
      }
      currentTask = nextTask;
    }

    // Calculate max parallelism
    const maxParallelism = Math.max(...waves.map(w => w.length));

    return {
      waves,
      totalWaves: waves.length,
      criticalPath,
      maxParallelism,
    };
  }
}
