/**
 * Task Queue - Priority-based task queue with dependency resolution.
 *
 * Features:
 * - Priority-based scheduling (critical > high > normal > low)
 * - Dependency resolution (sequential and conditional)
 * - Task lifecycle management
 * - History tracking
 *
 * @module queue/task-queue
 */
import { createLogger } from '../utils/logger.js';
const logger = createLogger('TaskQueue');
// ============================================================================
// Priority Values
// ============================================================================
/**
 * Numeric priority values for sorting.
 * Higher value = higher priority.
 */
const PRIORITY_VALUES = {
    critical: 4,
    high: 3,
    normal: 2,
    low: 1,
};
// ============================================================================
// Task Queue Implementation
// ============================================================================
/**
 * Priority-based task queue with dependency resolution.
 *
 * @example
 * ```typescript
 * const queue = new TaskQueue();
 *
 * // Add tasks
 * queue.enqueue({
 *   id: 'task-1',
 *   name: 'First task',
 *   prompt: 'Do something',
 *   priority: 'high',
 * });
 *
 * // Get next available task
 * const task = queue.dequeue();
 *
 * // Update task status
 * queue.updateStatus('task-1', 'running');
 * ```
 */
export class TaskQueue {
    tasks = new Map();
    pendingQueue = []; // Ordered by priority
    completedTasks = [];
    maxHistorySize;
    constructor(maxHistorySize = 100) {
        this.maxHistorySize = maxHistorySize;
    }
    // --------------------------------------------------------------------------
    // Task Management
    // --------------------------------------------------------------------------
    /**
     * Add a task to the queue.
     *
     * @param options - Task options
     * @param createTask - Factory function to create the task
     * @returns The created task
     */
    enqueue(options, createTask) {
        const task = createTask
            ? createTask(options)
            : this.createDefaultTask(options);
        this.tasks.set(task.id, task);
        this.insertIntoQueue(task.id);
        logger.debug({ taskId: task.id, priority: task.priority }, 'Task enqueued');
        return task;
    }
    /**
     * Create a default task from options.
     * Can be overridden by subclasses.
     */
    createDefaultTask(options) {
        return {
            ...options,
            status: 'pending',
            createdAt: new Date(),
            retryCount: 0,
            priority: options.priority ?? 'normal',
            timeout: options.timeout ?? 300000,
            maxRetries: options.maxRetries ?? 0,
            dependencies: options.dependencies ?? [],
        };
    }
    /**
     * Add multiple tasks to the queue.
     *
     * @param optionsList - Array of task options
     * @param createTask - Factory function to create tasks
     * @returns Array of created tasks
     */
    enqueueBatch(optionsList, createTask) {
        return optionsList.map(options => this.enqueue(options, createTask));
    }
    /**
     * Get and remove the next available task from the queue.
     *
     * Only returns tasks whose dependencies are satisfied.
     *
     * @returns The next task or undefined if none available
     */
    dequeue() {
        // Find first task with satisfied dependencies
        for (let i = 0; i < this.pendingQueue.length; i++) {
            const taskId = this.pendingQueue[i];
            const task = this.tasks.get(taskId);
            if (task && this.areDependenciesSatisfied(task)) {
                // Remove from queue
                this.pendingQueue.splice(i, 1);
                return task;
            }
        }
        return undefined;
    }
    /**
     * Peek at the next task without removing it.
     *
     * @returns The next task or undefined
     */
    peek() {
        for (const taskId of this.pendingQueue) {
            const task = this.tasks.get(taskId);
            if (task && this.areDependenciesSatisfied(task)) {
                return task;
            }
        }
        return undefined;
    }
    /**
     * Get a task by ID.
     *
     * @param taskId - Task ID
     * @returns The task or undefined
     */
    get(taskId) {
        return this.tasks.get(taskId);
    }
    /**
     * Update task status.
     *
     * @param taskId - Task ID
     * @param status - New status
     * @param result - Optional result data
     */
    updateStatus(taskId, status, result) {
        const task = this.tasks.get(taskId);
        if (!task) {
            logger.warn({ taskId }, 'Task not found for status update');
            return;
        }
        task.status = status;
        if (status === 'running' && !task.startedAt) {
            task.startedAt = new Date();
        }
        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
            task.completedAt = new Date();
            task.result = {
                taskId,
                status,
                startedAt: task.startedAt,
                completedAt: task.completedAt,
                duration: task.startedAt
                    ? task.completedAt.getTime() - task.startedAt.getTime()
                    : undefined,
                retryCount: task.retryCount,
                ...result,
            };
            // Move to history
            this.completedTasks.push(task);
            this.tasks.delete(taskId);
            // Trim history if needed
            while (this.completedTasks.length > this.maxHistorySize) {
                this.completedTasks.shift();
            }
        }
        logger.debug({ taskId, status }, 'Task status updated');
    }
    /**
     * Remove a task from the queue.
     *
     * @param taskId - Task ID
     * @returns True if removed, false if not found
     */
    remove(taskId) {
        const task = this.tasks.get(taskId);
        if (!task) {
            return false;
        }
        // Remove from queue
        const queueIndex = this.pendingQueue.indexOf(taskId);
        if (queueIndex !== -1) {
            this.pendingQueue.splice(queueIndex, 1);
        }
        this.tasks.delete(taskId);
        logger.debug({ taskId }, 'Task removed from queue');
        return true;
    }
    /**
     * Cancel a task.
     *
     * @param taskId - Task ID
     * @returns True if cancelled, false if not found
     */
    cancel(taskId) {
        const task = this.tasks.get(taskId);
        if (!task || task.status === 'running') {
            return false;
        }
        this.updateStatus(taskId, 'cancelled');
        return true;
    }
    // --------------------------------------------------------------------------
    // Query Methods
    // --------------------------------------------------------------------------
    /**
     * Get all pending tasks.
     *
     * @returns Array of pending tasks
     */
    getPending() {
        return this.pendingQueue
            .map(id => this.tasks.get(id))
            .filter((t) => t !== undefined);
    }
    /**
     * Get all running tasks.
     *
     * @returns Array of running tasks
     */
    getRunning() {
        return Array.from(this.tasks.values()).filter(t => t.status === 'running');
    }
    /**
     * Get completed task history.
     *
     * @returns Array of completed tasks
     */
    getHistory() {
        return [...this.completedTasks];
    }
    /**
     * Get queue size (pending tasks only).
     *
     * @returns Number of pending tasks
     */
    size() {
        return this.pendingQueue.length;
    }
    /**
     * Check if queue is empty.
     *
     * @returns True if no pending tasks
     */
    isEmpty() {
        return this.pendingQueue.length === 0;
    }
    /**
     * Check if there are any available tasks (with satisfied dependencies).
     *
     * @returns True if at least one task is available
     */
    hasAvailableTasks() {
        return this.peek() !== undefined;
    }
    /**
     * Get number of tasks by status.
     *
     * @param status - Task status
     * @returns Count of tasks with that status
     */
    countByStatus(status) {
        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
            return this.completedTasks.filter(t => t.status === status).length;
        }
        return Array.from(this.tasks.values()).filter(t => t.status === status).length;
    }
    // --------------------------------------------------------------------------
    // Dependency Management
    // --------------------------------------------------------------------------
    /**
     * Check if all dependencies for a task are satisfied.
     *
     * @param task - Task to check
     * @returns True if all dependencies are satisfied
     */
    areDependenciesSatisfied(task) {
        if (!task.dependencies || task.dependencies.length === 0) {
            return true;
        }
        for (const dep of task.dependencies) {
            // Check in history for completed dependencies
            const completedDep = this.completedTasks.find(t => t.id === dep.taskId);
            if (!completedDep || completedDep.status !== 'completed') {
                // Dependency not completed yet
                if (dep.type === 'conditional') {
                    // Conditional dependencies might be skipped based on condition
                    // For now, we treat them as required
                    continue;
                }
                return false;
            }
        }
        return true;
    }
    /**
     * Get tasks that depend on a given task.
     *
     * @param taskId - Task ID
     * @returns Array of dependent tasks
     */
    getDependents(taskId) {
        return Array.from(this.tasks.values()).filter(task => task.dependencies?.some(dep => dep.taskId === taskId));
    }
    // --------------------------------------------------------------------------
    // Private Helpers
    // --------------------------------------------------------------------------
    /**
     * Insert task ID into priority queue at correct position.
     */
    insertIntoQueue(taskId) {
        const task = this.tasks.get(taskId);
        if (!task || !task.priority) {
            return;
        }
        const priorityValue = PRIORITY_VALUES[task.priority];
        // Find insertion point (higher priority first)
        let insertIndex = this.pendingQueue.length;
        for (let i = 0; i < this.pendingQueue.length; i++) {
            const queuedTask = this.tasks.get(this.pendingQueue[i]);
            if (queuedTask && queuedTask.priority && PRIORITY_VALUES[queuedTask.priority] < priorityValue) {
                insertIndex = i;
                break;
            }
        }
        this.pendingQueue.splice(insertIndex, 0, taskId);
    }
    // --------------------------------------------------------------------------
    // Cleanup
    // --------------------------------------------------------------------------
    /**
     * Clear all tasks from the queue.
     */
    clear() {
        this.tasks.clear();
        this.pendingQueue = [];
        logger.debug('Task queue cleared');
    }
    /**
     * Clear completed task history.
     */
    clearHistory() {
        this.completedTasks = [];
        logger.debug('Task history cleared');
    }
}
