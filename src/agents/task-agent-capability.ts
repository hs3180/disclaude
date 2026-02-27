/**
 * Task Agent Capability - Shared capability for task-oriented agents.
 *
 * This module provides reusable capabilities for task agents (Evaluator, Executor, Reporter)
 * through composition rather than inheritance.
 *
 * Design principle: "Composition over inheritance"
 * - Agents compose these capabilities instead of inheriting from a base class
 * - Each capability is independent and testable in isolation
 *
 * @module agents/task-agent-capability
 */

import { Config } from '../config/index.js';
import { TaskFileManager } from '../task/task-files.js';
import type { TaskAgentRole, AgentLifecyclePhase, AgentLifecycleEvent } from './types.js';

/**
 * Options for TaskAgentCapability.
 */
export interface TaskAgentCapabilityOptions {
  /** Agent role */
  role: TaskAgentRole;
  /** Agent name for logging */
  agentName: string;
  /** Optional subdirectory for task files */
  subdirectory?: string;
  /** Lifecycle event callback */
  onLifecycleEvent?: (event: AgentLifecycleEvent) => void;
}

/**
 * Task Agent Capability - Provides shared functionality for task agents.
 *
 * This class encapsulates common capabilities needed by task-oriented agents:
 * - File management via TaskFileManager
 * - Lifecycle state tracking
 * - Role-based classification
 *
 * @example
 * ```typescript
 * class Evaluator extends BaseAgent {
 *   private taskCapability: TaskAgentCapability;
 *
 *   constructor(config: EvaluatorConfig) {
 *     super(config);
 *     this.taskCapability = new TaskAgentCapability({
 *       role: 'evaluator',
 *       agentName: 'Evaluator',
 *       subdirectory: config.subdirectory,
 *     });
 *   }
 *
 *   getAgentType(): TaskAgentType {
 *     return this.taskCapability.getAgentType();
 *   }
 * }
 * ```
 */
export class TaskAgentCapability {
  private readonly role: TaskAgentRole;
  private readonly agentName: string;
  private readonly fileManager: TaskFileManager;
  private readonly onLifecycleEvent?: (event: AgentLifecycleEvent) => void;

  private lifecyclePhase: AgentLifecyclePhase = 'created';
  private initialized = false;

  constructor(options: TaskAgentCapabilityOptions) {
    this.role = options.role;
    this.agentName = options.agentName;
    this.onLifecycleEvent = options.onLifecycleEvent;
    this.fileManager = new TaskFileManager(
      Config.getWorkspaceDir(),
      options.subdirectory
    );
  }

  /**
   * Get the agent role.
   */
  getRole(): TaskAgentRole {
    return this.role;
  }

  /**
   * Get the agent name.
   */
  getAgentName(): string {
    return this.agentName;
  }

  /**
   * Get the file manager instance.
   */
  getFileManager(): TaskFileManager {
    return this.fileManager;
  }

  /**
   * Get agent type information.
   */
  getAgentType(): { category: 'task'; name: string; role: TaskAgentRole } {
    return {
      category: 'task',
      name: this.agentName,
      role: this.role,
    };
  }

  /**
   * Check if initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Mark as initialized.
   */
  setInitialized(value: boolean): void {
    this.initialized = value;
  }

  /**
   * Get current lifecycle phase.
   */
  getLifecyclePhase(): AgentLifecyclePhase {
    return this.lifecyclePhase;
  }

  /**
   * Transition to a new lifecycle phase.
   */
  transitionPhase(newPhase: AgentLifecyclePhase): void {
    const previousPhase = this.lifecyclePhase;
    this.lifecyclePhase = newPhase;

    this.onLifecycleEvent?.({
      agentName: this.agentName,
      previousPhase,
      currentPhase: newPhase,
      timestamp: new Date(),
    });
  }

  /**
   * Check if ready for operations.
   */
  isReady(): boolean {
    return this.initialized && this.lifecyclePhase === 'ready';
  }

  /**
   * Initialize the capability.
   * Transitions lifecycle phase from created -> initializing -> ready.
   */
  initialize(): void {
    if (this.initialized) {
      return;
    }

    this.transitionPhase('initializing');
    this.initialized = true;
    this.transitionPhase('ready');
  }

  /**
   * Cleanup the capability.
   * Transitions lifecycle phase to cleanup -> disposed.
   */
  cleanup(): void {
    this.transitionPhase('cleanup');
    this.initialized = false;
    this.transitionPhase('disposed');
  }
}

/**
 * Allowed tools configuration for each task agent role.
 */
export const TASK_AGENT_TOOLS: Record<TaskAgentRole, string[]> = {
  evaluator: ['Read', 'Grep', 'Glob', 'Write'],
  executor: [], // Executor uses all tools via permissionMode: bypassPermissions
  reporter: ['send_user_feedback', 'send_file_to_feishu'],
} as const;

/**
 * Get allowed tools for a task agent role.
 */
export function getTaskAgentTools(role: TaskAgentRole): string[] {
  return [...TASK_AGENT_TOOLS[role]];
}
