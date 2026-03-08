/**
 * Spawn Subagents tool implementation.
 *
 * This tool provides a master-workers pattern for parallel task execution.
 * It uses SubagentManager to spawn multiple subagents and collect results.
 *
 * Issue #897: Master-Workers Multi-Agent Collaboration Pattern
 *
 * @module mcp/tools/spawn-subagents
 */

import { createLogger } from '../../utils/logger.js';
import {
  SubagentManager,
  type SubagentOptions,
  type SubagentHandle,
  type SubagentStatus,
  type PilotCallbacks,
} from '../../agents/index.js';

const logger = createLogger('SpawnSubagents');

/**
 * Result from spawn_subagents tool.
 */
export interface SpawnSubagentsResult {
  success: boolean;
  message: string;
  results: SubagentResult[];
  summary?: string;
  error?: string;
}

/**
 * Result from a single subagent.
 */
export interface SubagentResult {
  id: string;
  name: string;
  status: SubagentStatus;
  output?: string;
  error?: string;
  duration: number;
}

/**
 * Options for spawning multiple subagents.
 */
export interface SpawnSubagentsOptions {
  /** Array of tasks to execute in parallel */
  tasks: SubagentTask[];
  /** Maximum number of parallel executions (default: 3) */
  maxParallel?: number;
  /** Timeout in milliseconds for all tasks (default: 300000 = 5 minutes) */
  timeout?: number;
  /** Continue on failure (default: true) */
  continueOnFailure?: boolean;
}

/**
 * A single task for a subagent.
 */
export interface SubagentTask {
  /** Type of subagent to spawn */
  type: SubagentOptions['type'];
  /** Name/identifier for this task */
  name: string;
  /** Prompt/task for the subagent */
  prompt: string;
  /** Optional template variables for skill agents */
  templateVars?: Record<string, string>;
}

// ============================================================================
// Global Callback Registration
// ============================================================================

/**
 * Global callbacks for spawn_subagents tool.
 * Set by the Pilot agent when starting a session.
 */
let globalCallbacks: PilotCallbacks | null = null;
let globalChatId: string | null = null;

/**
 * Set the global callbacks for spawn_subagents tool.
 * Called by Pilot when starting an agent session.
 */
export function setSpawnSubagentsCallbacks(callbacks: PilotCallbacks | null, chatId: string | null): void {
  globalCallbacks = callbacks;
  globalChatId = chatId;
  logger.debug({ hasCallbacks: !!callbacks, chatId }, 'Set spawn_subagents callbacks');
}

/**
 * Get the current global callbacks.
 */
export function getSpawnSubagentsCallbacks(): { callbacks: PilotCallbacks | null; chatId: string | null } {
  return { callbacks: globalCallbacks, chatId: globalChatId };
}

// ============================================================================
// Global SubagentManager
// ============================================================================

/**
 * Global SubagentManager instance for spawn_subagents tool.
 * Lazily initialized on first use.
 */
let globalSpawnManager: SubagentManager | undefined;

/**
 * Get or create the global SubagentManager for spawn_subagents.
 */
function getSpawnManager(): SubagentManager {
  if (!globalSpawnManager) {
    globalSpawnManager = new SubagentManager();
  }
  return globalSpawnManager;
}

/**
 * Wait for all subagents to complete with optional timeout.
 */
function waitForCompletion(
  handles: SubagentHandle[],
  manager: SubagentManager,
  timeout?: number
): Promise<void> {
  const startTime = Date.now();
  const timeoutMs = timeout || 300000; // 5 minutes default

  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      const allDone = handles.every(
        (h) => h.status === 'completed' || h.status === 'failed' || h.status === 'stopped'
      );

      if (allDone) {
        clearInterval(checkInterval);
        resolve();
        return;
      }

      // Check timeout
      if (Date.now() - startTime > timeoutMs) {
        logger.warn({ handleCount: handles.length }, 'Timeout reached, terminating running subagents');
        for (const handle of handles) {
          if (handle.status === 'running') {
            manager.terminate(handle.id);
          }
        }
        clearInterval(checkInterval);
        resolve();
      }
    }, 500);
  });
}

/**
 * Collect results from completed subagents.
 */
function collectResults(handles: SubagentHandle[]): SubagentResult[] {
  return handles.map((handle) => ({
    id: handle.id,
    name: handle.name,
    status: handle.status,
    output: handle.output,
    error: handle.error,
    duration: handle.completedAt
      ? handle.completedAt.getTime() - handle.startedAt.getTime()
      : Date.now() - handle.startedAt.getTime(),
  }));
}

/**
 * Generate a summary of results.
 */
function generateSummary(results: SubagentResult[]): string {
  const completed = results.filter((r) => r.status === 'completed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const stopped = results.filter((r) => r.status === 'stopped').length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  const lines = [
    '## 执行结果汇总',
    '',
    `- ✅ 成功: ${completed}`,
    `- ❌ 失败: ${failed}`,
    `- ⏹️ 中止: ${stopped}`,
    `- ⏱️ 总耗时: ${(totalDuration / 1000).toFixed(1)}s`,
  ];

  if (failed > 0) {
    lines.push('', '### 失败的任务', '');
    for (const result of results.filter((r) => r.status === 'failed')) {
      lines.push(`- **${result.name}**: ${result.error || 'Unknown error'}`);
    }
  }

  return lines.join('\n');
}

/**
 * Spawn multiple subagents in parallel and collect results.
 *
 * This tool implements the master-workers pattern (Issue #897) using
 * the existing SubagentManager infrastructure.
 *
 * @example
 * ```typescript
 * const result = await spawn_subagents({
 *   tasks: [
 *     { type: 'task', name: 'analyze-file-a', prompt: 'Analyze file A' },
 *     { type: 'task', name: 'analyze-file-b', prompt: 'Analyze file B' },
 *   ],
 *   maxParallel: 2,
 * });
 * ```
 */
export async function spawn_subagents(
  params: SpawnSubagentsOptions
): Promise<SpawnSubagentsResult> {
  const {
    tasks,
    maxParallel = 3,
    timeout,
    continueOnFailure = true,
  } = params;

  // Get callbacks and chatId from global context
  const { callbacks, chatId } = getSpawnSubagentsCallbacks();

  logger.info(
    { taskCount: tasks.length, maxParallel, chatId },
    'spawn_subagents called'
  );

  // Validate inputs
  if (!tasks || tasks.length === 0) {
    return {
      success: false,
      message: '❌ 没有提供任务',
      results: [],
      error: 'tasks array is empty',
    };
  }

  if (!callbacks || !callbacks.sendMessage) {
    return {
      success: false,
      message: '❌ 缺少必要的回调函数，请确保在会话上下文中调用此工具',
      results: [],
      error: 'callbacks.sendMessage is required (not in session context)',
    };
  }

  if (!chatId) {
    return {
      success: false,
      message: '❌ 缺少 chatId，请确保在会话上下文中调用此工具',
      results: [],
      error: 'chatId is required (not in session context)',
    };
  }

  try {
    const manager = getSpawnManager();
    const handles: SubagentHandle[] = [];

    // Spawn subagents in batches to respect maxParallel
    for (let i = 0; i < tasks.length; i += maxParallel) {
      const batch = tasks.slice(i, i + maxParallel);

      // Spawn batch in parallel
      const batchPromises = batch.map(async (task) => {
        try {
          const options: SubagentOptions = {
            type: task.type,
            name: task.name,
            prompt: task.prompt,
            chatId,
            callbacks,
            templateVars: task.templateVars,
          };

          const handle = await manager.spawn(options);
          return handle;
        } catch (error) {
          logger.error({ err: error, task: task.name }, 'Failed to spawn subagent');
          // Return a failed handle
          return {
            id: `failed-${task.name}`,
            type: task.type,
            name: task.name,
            chatId,
            status: 'failed' as SubagentStatus,
            startedAt: new Date(),
            completedAt: new Date(),
            error: error instanceof Error ? error.message : String(error),
            isolation: 'none' as const,
          };
        }
      });

      const batchHandles = await Promise.all(batchPromises);
      handles.push(...batchHandles);

      // If continueOnFailure is false, check for failures
      if (!continueOnFailure) {
        const hasFailure = batchHandles.some((h) => h.status === 'failed');
        if (hasFailure) {
          logger.warn('Stopping due to failure (continueOnFailure=false)');
          break;
        }
      }
    }

    // Wait for all to complete
    await waitForCompletion(handles, manager, timeout);

    // Collect results
    const results = collectResults(handles);
    const summary = generateSummary(results);

    // Determine overall success
    const allCompleted = results.every((r) => r.status === 'completed');
    const anyFailed = results.some((r) => r.status === 'failed');

    return {
      success: allCompleted,
      message: allCompleted
        ? `✅ 所有任务完成 (${results.length}/${tasks.length})`
        : anyFailed
          ? `⚠️ 部分任务失败 (${results.filter((r) => r.status === 'completed').length}/${tasks.length} 成功)`
          : '⏹️ 任务被中止',
      results,
      summary,
    };
  } catch (error) {
    logger.error({ err: error }, 'spawn_subagents failed');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      message: `❌ 执行失败: ${errorMessage}`,
      results: [],
      error: errorMessage,
    };
  }
}

/**
 * Dispose of the global spawn manager.
 */
export function disposeSpawnManager(): void {
  if (globalSpawnManager) {
    globalSpawnManager.dispose();
    globalSpawnManager = undefined;
  }
}
