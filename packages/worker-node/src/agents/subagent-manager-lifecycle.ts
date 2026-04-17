/**
 * Subagent lifecycle management functions.
 *
 * Extracted from subagent-manager.ts as part of #2345 Phase 4
 * to keep the main module under 300 lines.
 *
 * Handles agent execution, termination, cleanup, and disposal.
 *
 * @module agents/subagent-manager-lifecycle
 */

import { createLogger } from '@disclaude/core';
import { AgentFactory } from './factory.js';
import type {
  SubagentOptions,
  SubagentHandle,
  SubagentContext,
} from './subagent-manager-types.js';

const logger = createLogger('SubagentManager');

/**
 * Execute an in-memory agent and track its lifecycle.
 *
 * Handles the common execution pattern for both schedule and task subagents:
 * 1. Create agent via AgentFactory
 * 2. Store in memory map
 * 3. Execute the prompt
 * 4. Handle success/failure status updates
 * 5. Clean up agent resources
 *
 * @param subagentId - Unique subagent identifier
 * @param options - Original spawn options
 * @param ctx - Internal SubagentManager state
 */
export async function executeSubagent(
  subagentId: string,
  options: SubagentOptions,
  ctx: SubagentContext,
): Promise<void> {
  const handle = ctx.handles.get(subagentId);
  if (!handle) {
    throw new Error(`Subagent handle not found: ${subagentId}`);
  }

  // Create agent using factory
  const agent = AgentFactory.createAgent(
    options.chatId,
    options.callbacks,
  );

  ctx.inMemoryAgents.set(subagentId, agent);
  handle.status = 'running';

  logger.info({ subagentId, name: options.name, type: options.type }, 'Subagent started');
  ctx.notifyStatusChange(handle);

  // Execute task
  try {
    await agent.executeOnce(
      options.chatId,
      options.prompt,
      undefined,
      options.senderOpenId,
    );

    handle.status = 'completed';
    handle.completedAt = new Date();
    logger.info({ subagentId }, 'Subagent completed');
  } catch (error) {
    handle.status = 'failed';
    handle.error = error instanceof Error ? error.message : String(error);
    handle.completedAt = new Date();
    logger.error({ err: error, subagentId }, 'Subagent failed');
  }

  ctx.notifyStatusChange(handle);

  // Cleanup
  try {
    agent.dispose();
  } catch (err) {
    logger.error({ err, subagentId }, 'Error disposing agent');
  }
  ctx.inMemoryAgents.delete(subagentId);
}

/**
 * Terminate a running subagent and clean up resources.
 *
 * Handles both child process termination and in-memory agent disposal.
 *
 * @param subagentId - ID of subagent to terminate
 * @param ctx - Internal SubagentManager state
 * @returns True if terminated, false if not found
 */
export function terminateSubagent(
  subagentId: string,
  ctx: SubagentContext,
): boolean {
  const handle = ctx.handles.get(subagentId);
  if (!handle) {
    return false;
  }

  // Terminate child process if any
  const childProcess = ctx.processes.get(subagentId);
  if (childProcess) {
    childProcess.kill('SIGTERM');
    ctx.processes.delete(subagentId);
  }

  // Dispose in-memory agent if any
  const agent = ctx.inMemoryAgents.get(subagentId);
  if (agent) {
    try {
      agent.dispose();
    } catch (err) {
      logger.error({ err, subagentId }, 'Error disposing agent during termination');
    }
    ctx.inMemoryAgents.delete(subagentId);
  }

  handle.status = 'stopped';
  handle.completedAt = new Date();
  ctx.notifyStatusChange(handle);

  logger.info({ subagentId }, 'Subagent terminated');
  return true;
}

/**
 * Clean up completed/failed/stopped subagents that exceed maxAge.
 *
 * @param handles - Map of subagent handles
 * @param maxAge - Maximum age in milliseconds (default: 1 hour)
 * @returns Number of cleaned up handles
 */
export function cleanupOldHandles(
  handles: Map<string, SubagentHandle>,
  maxAge: number = 3600000,
): number {
  const now = Date.now();
  const toDelete: string[] = [];

  for (const [id, handle] of handles) {
    if (
      (handle.status === 'completed' || handle.status === 'failed' || handle.status === 'stopped') &&
      handle.completedAt &&
      now - handle.completedAt.getTime() > maxAge
    ) {
      toDelete.push(id);
    }
  }

  for (const id of toDelete) {
    handles.delete(id);
  }

  if (toDelete.length > 0) {
    logger.debug({ count: toDelete.length }, 'Cleaned up old subagent records');
  }

  return toDelete.length;
}
