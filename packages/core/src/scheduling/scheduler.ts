/**
 * Scheduler - Executes scheduled tasks using cron.
 *
 * Uses node-cron to schedule task execution.
 * Integrates with ScheduleManager for task management.
 *
 * Issue #3582: Routes tasks through InputMessageRouter as SystemMessage.
 * Tasks are delivered to existing persistent agents via AgentPool.
 *
 * Features:
 * - Dynamic task scheduling
 * - Automatic reload of tasks on schedule changes
 *
 * @module @disclaude/core/scheduling
 */

import { CronJob } from 'cron';
import { createLogger } from '../utils/logger.js';
import { CooldownManager } from './cooldown-manager.js';
import type { ScheduleManager } from './schedule-manager.js';
import { DEFAULT_TIMEZONE, type ScheduledTask } from './scheduled-task.js';
import type { TaskFailureStore } from './task-failure-store.js';
import type { MessageRouter as InputMessageRouter } from '../messaging/message-router.js';
import { TurnSupersededError } from '../messaging/turn-superseded-error.js';
import type { SystemMessage } from '../types/message.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const logger = createLogger('Scheduler');

/**
 * Format timeout duration for display.
 * Shows seconds when under 1 minute, otherwise shows minutes.
 */
function formatTimeout(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) {
    return `${Math.round(ms / 1000)}秒`;
  }
  return `${minutes}分钟`;
}

/**
 * Default timeout bounding how long executeTask waits for the agent TURN to
 * finish (Issue #3894 introduced it; #4648 widened it from routing to the
 * whole turn via waitForCompletion).
 *
 * Issue #4649 (review ②): 5 minutes was calibrated for the OLD semantics
 * (bounding the route/queue call, which completes in well under a second);
 * applied to whole turns it falsely failed every legitimately long task.
 * The new default is deliberately ABOVE the agent pool's busy-turn hard cap
 * (90 min default, Issue #4577, wired in cli.ts): a genuinely stuck turn is
 * killed by the pool cap first and lands in the catch as a REAL error —
 * countable toward the #4648 consecutive-failure alert — while this timeout
 * only fires for turns legitimately longer than 2 hours, which are expected
 * to declare their duration via `timeoutMs` in SCHEDULE.md.
 *
 * When this timeout fires the agent is NOT cancelled (the abandoned await
 * never could), so the outcome is unknown rather than failed — see the
 * TaskTimeoutError branch in executeTask's catch.
 */
const DEFAULT_TASK_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * Issue #4648: alert threshold — a scheduled task failing this many times in
 * a row emits an error-level structured log carrying
 * `scheduleConsecutiveFailures`, so chronic silent failures (the 38-day
 * #4626/#4648 incident) become detectable via log search instead of
 * surfacing as an endless stream of identical single-run failures.
 */
const CONSECUTIVE_FAILURE_ALERT_THRESHOLD = 3;

/**
 * Error thrown when a scheduled task execution times out.
 *
 * Issue #3894: Used to distinguish timeout errors from other failures,
 * allowing specific error notification to the user.
 */
export class TaskTimeoutError extends Error {
  /** Task ID that timed out */
  readonly taskId: string;
  /** Timeout duration in milliseconds */
  readonly timeoutMs: number;

  constructor(taskId: string, timeoutMs: number) {
    super(`Scheduled task "${taskId}" timed out after ${formatTimeout(timeoutMs)}`);
    this.name = 'TaskTimeoutError';
    this.taskId = taskId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Minimal job interface the Scheduler relies on.
 *
 * Issue #4218 (fix A): dependency-inject the job so unit tests can use a
 * deterministic driver that never schedules a real OS timer (the root cause
 * of the scheduler-test flakes — `addTask` created a CronJob with
 * `start: true`, leaking real `setTimeout`s across tests). `CronJob` satisfies
 * this interface, so production behavior is unchanged when no factory is
 * injected.
 */
export interface SchedulerJob {
  /**
   * Manually fire the job's onTick (used by tests to drive execution).
   * `void | Promise<void>` because `CronJob.fireOnTick()` resolves a
   * `Promise<void>` while test fakes return `void`; callers never await it.
   */
  fireOnTick(): void | Promise<void>;
  /** Stop the job and cancel any scheduled execution. */
  stop(): void;
}

/**
 * Factory that creates a {@link SchedulerJob} for a task.
 *
 * Issue #4218 (fix A): when provided via {@link SchedulerOptions.jobFactory},
 * the Scheduler uses this instead of constructing a real `CronJob`, letting
 * tests inject a fake job with no wall-clock side effects. Production code
 * leaves this unset and gets a real, auto-started `CronJob`.
 *
 * The signature intentionally mirrors only what the Scheduler supplies — it
 * omits `CronJob`'s `onComplete`/`start` args because a test factory must NOT
 * auto-start a real timer (the whole point of the DI). Production never sets
 * `jobFactory`, so the real `CronJob(task.cron, onTick, null, true, timezone)`
 * path is unaffected.
 */
export type SchedulerJobFactory = (
  cron: string,
  /** Real onTick is `() => this.executeTask(task)` (async → Promise<void>); fakes may return void. */
  onTick: () => void | Promise<void>,
  timezone: string,
) => SchedulerJob;

/**
 * Active cron job entry.
 */
interface ActiveJob {
  taskId: string;
  job: SchedulerJob;
  task: ScheduledTask;
}

/**
 * Callbacks for sending messages.
 * Simplified interface for dependency injection.
 */
export interface SchedulerCallbacks {
  /** Send a text message to a chat */
  sendMessage: (chatId: string, message: string) => Promise<void>;
  /**
   * @deprecated Compatibility hook only; scheduled executions no longer reset
   * the user's persistent agent. Fresh sessions are owned by the pool handler.
   */
  resetAgent?: (chatId: string, skipContext?: boolean) => void;
  /**
   * Report whether the agent for a chat is currently processing a message
   * (busy). When wired, a task whose target chat is busy is skipped this tick
   * instead of being dispatched into an in-flight conversation. Optional; when
   * absent, behavior is unchanged.
   */
  isChatBusy?: (chatId: string) => boolean;
}

/** Result returned by a directly executed schedule command. */
export interface CommandExecutionResult {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/** Injectable command runner; the default runner is used in production. */
export type CommandRunner = (command: string, options: {
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}) => Promise<CommandExecutionResult>;

const COMMAND_DIAGNOSTIC_LIMIT_BYTES = 64 * 1024;
const COMMAND_KILL_GRACE_MS = 1000;

export class CommandCancelledError extends Error {
  constructor() {
    super('Scheduled command cancelled');
    this.name = 'CommandCancelledError';
  }
}

export class CommandTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Scheduled command timed out after ${formatTimeout(timeoutMs)}`);
    this.name = 'CommandTimeoutError';
  }
}

function appendDiagnostic(current: Buffer, chunk: Buffer): { value: Buffer; truncated: boolean } {
  const remaining = COMMAND_DIAGNOSTIC_LIMIT_BYTES - current.length;
  if (remaining <= 0) { return { value: current, truncated: true }; }
  return {
    value: Buffer.concat([current, chunk.subarray(0, remaining)]),
    truncated: chunk.length > remaining,
  };
}

/** Real POSIX runner used by production and process-lifecycle tests. */
export const defaultCommandRunner: CommandRunner = (command, options) => {
  // A pre-cancelled schedule must not spawn: even a short-lived shell could
  // perform a side effect before an abort listener gets its first turn.
  if (options.signal.aborted) { return Promise.reject(new CommandCancelledError()); }

  return new Promise((resolve, reject) => {
  const child = spawn('/bin/sh', ['-c', command], {
    detached: process.platform !== 'win32',
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout: Buffer = Buffer.alloc(0);
  let stderr: Buffer = Buffer.alloc(0);
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let settled = false;
  let termination: 'cancelled' | 'timeout' | undefined;
  let terminationTimer: ReturnType<typeof setTimeout> | undefined;

  const terminate = (signal: NodeJS.Signals): void => {
    if (!child.pid) { return; }
    try {
      if (process.platform === 'win32') {
        if (child.exitCode === null && child.signalCode === null) { child.kill(signal); }
      }
      else { process.kill(-child.pid, signal); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        logger.warn({ err: error, pid: child.pid }, 'Failed to terminate scheduled command process group');
      }
    }
  };

  const result = (): CommandExecutionResult => ({
    stdout: stdout.toString('utf8'),
    stderr: stderr.toString('utf8'),
    stdoutTruncated,
    stderrTruncated,
  });
  const groupIsAlive = (): boolean => {
    if (!child.pid) { return false; }
    if (process.platform === 'win32') {
      return child.exitCode === null && child.signalCode === null;
    }
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  };
  const cleanup = (): void => {
    clearTimeout(timeout);
    if (terminationTimer) { clearTimeout(terminationTimer); }
    options.signal.removeEventListener('abort', onAbort);
  };
  const settleTermination = (): void => {
    if (settled || !termination) { return; }
    settled = true;
    cleanup();
    const error = termination === 'cancelled'
      ? new CommandCancelledError()
      : new CommandTimeoutError(options.timeoutMs);
    reject(Object.assign(error, result()));
  };
  const awaitKilledGroup = (deadline: number): void => {
    if (!groupIsAlive() || Date.now() >= deadline) {
      if (groupIsAlive()) {
        logger.error({ pid: child.pid }, 'Scheduled command process group remained after SIGKILL');
      }
      settleTermination();
      return;
    }
    terminationTimer = setTimeout(() => awaitKilledGroup(deadline), 10);
  };
  const beginTermination = (kind: 'cancelled' | 'timeout'): void => {
    if (termination || settled) { return; }
    termination = kind;
    clearTimeout(timeout);
    terminate('SIGTERM');
    if (!groupIsAlive()) {
      settleTermination();
      return;
    }
    // This timer intentionally remains referenced: cancellation completion
    // means cleanup finished, not merely that the shell's close event fired.
    terminationTimer = setTimeout(() => {
      terminate('SIGKILL');
      awaitKilledGroup(Date.now() + 250);
    }, COMMAND_KILL_GRACE_MS);
  };

  const timeout = setTimeout(() => beginTermination('timeout'), options.timeoutMs);
  timeout.unref();
  const onAbort = (): void => beginTermination('cancelled');
  options.signal.addEventListener('abort', onAbort, { once: true });

  child.stdout.on('data', (chunk: Buffer) => {
    const next = appendDiagnostic(stdout, chunk);
    stdout = next.value;
    stdoutTruncated ||= next.truncated;
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const next = appendDiagnostic(stderr, chunk);
    stderr = next.value;
    stderrTruncated ||= next.truncated;
  });
  child.once('error', (error) => {
    if (settled) { return; }
    settled = true;
    cleanup();
    reject(error);
  });
  child.once('close', (code, signal) => {
    if (settled) { return; }
    if (termination) {
      if (!groupIsAlive()) { settleTermination(); }
      return;
    }
    settled = true;
    cleanup();
    const diagnostics = result();
    if (code !== 0) {
      reject(Object.assign(new Error(`Scheduled command exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`), diagnostics));
    } else {
      resolve(diagnostics);
    }
  });
  });
};

/**
 * Scheduler options.
 *
 * Issue #3582: Uses InputMessageRouter for task execution.
 * Issue #869: Added cooldownManager for cooldown period support.
 */
export interface SchedulerOptions {
  /** ScheduleManager instance for task CRUD */
  scheduleManager: ScheduleManager;
  /** Callbacks for sending messages */
  callbacks: SchedulerCallbacks;
  /** CooldownManager for cooldown period management */
  cooldownManager?: CooldownManager;
  /**
   * File-backed store for consecutive-failure streaks (Issue #4648 residual ⑥).
   * When wired, streaks survive restarts (crash-loop alerting becomes possible);
   * when absent, the Scheduler falls back to its in-memory map (previous
   * behavior — streaks zero on restart).
   */
  failureStore?: TaskFailureStore;
  /**
   * Input MessageRouter for routing scheduled tasks as SystemMessage.
   * Issue #3582: Routes through existing agents via AgentPool.
   */
  inputMessageRouter?: InputMessageRouter;
  /**
   * Optional job factory for dependency injection (Issue #4218, fix A).
   * When set, the Scheduler uses it to create each task's job instead of a
   * real `CronJob`, so tests can drive execution deterministically without
   * scheduling real OS timers. Production leaves this unset.
   */
  jobFactory?: SchedulerJobFactory;
  /** Direct runner for command schedules; defaults to /bin/sh -c. */
  commandRunner?: CommandRunner;
}

/**
 * Scheduler - Manages cron-based task execution.
 *
 * Issue #3582: Routes tasks through InputMessageRouter to existing agents.
 *
 * Usage:
 * ```typescript
 * const scheduler = new Scheduler({
 *   scheduleManager,
 *   callbacks,
 *   inputMessageRouter,
 * });
 *
 * // Start scheduler (loads and schedules all enabled tasks)
 * await scheduler.start();
 *
 * // Stop scheduler
 * await scheduler.stop();
 * ```
 */
export class Scheduler {
  /** Blocking isolated turns remain owned after their caller stops waiting. */
  private readonly isolatedBlockingTurns = new Map<string, string>();
  private scheduleManager: ScheduleManager;
  private callbacks: SchedulerCallbacks;
  private cooldownManager?: CooldownManager;
  private inputMessageRouter?: InputMessageRouter;
  /** Issue #4218 (fix A): injectable job factory; undefined → real CronJob. */
  private jobFactory?: SchedulerJobFactory;
  private commandRunner: CommandRunner;
  private activeCommandControllers = new Map<string, AbortController>();
  private activeJobs: Map<string, ActiveJob> = new Map();
  private running = false;
  /** Tracks tasks currently being executed (for blocking mechanism) */
  private runningTasks: Set<string> = new Set();
  /**
   * Issue #4102: Tracks chatIds that currently have a blocking scheduled task running.
   * Blocking tasks only skip when ANOTHER blocking scheduled task is running for the
   * same chatId — not when the agent is busy with user messages.
   */
  private runningBlockingTaskChatIds = new Set<string>();
  /**
   * Resolves when all running tasks have completed.
   * Created lazily when the first task starts; resolved and cleared when
   * runningTasks drains to zero. Used by stop() for graceful shutdown
   * without polling.
   *
   * Issue #3415.
   */
  private _drainPromise: Promise<void> | null = null;
  private _drainResolve: (() => void) | null = null;

  /**
   * Issue #4648: per-task consecutive-failure counter. Incremented in the
   * executeTask catch, deleted on success (a healthy run resets the streak).
   * Entries for deleted tasks are left to be GC'd with the instance — the
   * map is bounded by the number of distinct task ids over a process
   * lifetime, which is small.
   *
   * Issue #4648 residual ⑥: this map is only the FALLBACK used when no
   * {@link TaskFailureStore} is injected; with a store wired, all streak
   * reads/writes go through it so the count survives restarts.
   */
  private readonly consecutiveTaskFailures = new Map<string, number>();
  /** Issue #4648 residual ⑥: optional file-backed streak store. */
  private readonly failureStore?: TaskFailureStore;

  constructor(options: SchedulerOptions) {
    this.scheduleManager = options.scheduleManager;
    this.callbacks = options.callbacks;
    this.cooldownManager = options.cooldownManager;
    this.inputMessageRouter = options.inputMessageRouter;
    this.jobFactory = options.jobFactory;
    this.failureStore = options.failureStore;
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    logger.info('Scheduler created');
  }

  /**
   * Start the scheduler.
   * Loads all enabled tasks and schedules them.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Scheduler already running');
      return;
    }

    this.running = true;

    // Load and schedule all enabled tasks
    const tasks = await this.scheduleManager.listEnabled();
    for (const task of tasks) {
      await this.addTask(task);
    }

    logger.info({ taskCount: this.activeJobs.size }, 'Scheduler started');
  }

  /**
   * Graceful shutdown timeout for waiting on running tasks.
   * After this period, running tasks are abandoned.
   *
   * Issue #3415: Ensures test processes exit cleanly by waiting
   * for in-flight task executions to complete.
   */
  private static readonly GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5000;

  /**
   * Stop the scheduler.
   * Stops all active cron jobs and waits for running tasks to complete.
   *
   * Issue #3415: Made async to allow graceful shutdown of in-flight
   * task executions. Previously fire-and-forget, which caused test
   * processes to be killed (SIGKILL) before cron cleanup could finish.
   *
   * @param timeoutMs - Optional timeout in ms to wait for running tasks
   *   (default: 5000ms). Set to 0 to skip waiting.
   */
  async stop(timeoutMs?: number): Promise<void> {
    this.running = false;

    // Stop all cron timers first (prevents new executions)
    for (const [taskId, entry] of this.activeJobs) {
      entry.job.stop();
      logger.debug({ taskId }, 'Stopped cron job');
    }

    this.activeJobs.clear();

    // Command schedules own subprocesses, unlike agent turns. Cancel them
    // before waiting for drain so shutdown cannot abandon process groups.
    for (const controller of this.activeCommandControllers.values()) {
      controller.abort();
    }

    // Wait for currently running tasks to complete (graceful shutdown).
    // Issue #3415: Uses a drain promise instead of polling.
    const waitTimeout = timeoutMs ?? Scheduler.GRACEFUL_SHUTDOWN_TIMEOUT_MS;
    if (this._drainPromise && waitTimeout > 0) {
      logger.info(
        { taskIds: Array.from(this.runningTasks), timeoutMs: waitTimeout },
        'Waiting for running tasks to complete...'
      );

      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          if (this.runningTasks.size > 0) {
            logger.warn(
              { taskIds: Array.from(this.runningTasks) },
              'Graceful shutdown timed out, abandoning running tasks'
            );
          }
          resolve();
        }, waitTimeout);
      });

      await Promise.race([this._drainPromise, timeoutPromise]);
    }

    logger.info('Scheduler stopped');
  }

  /**
   * Add a task to the scheduler.
   * Creates a cron job for the task.
   *
   * @param task - Task to add
   */
  addTask(task: ScheduledTask): void {
    // Remove existing job if any
    this.removeTask(task.id);

    if (!task.enabled) {
      logger.debug({ taskId: task.id }, 'Task is disabled, not scheduling');
      return;
    }

    try {
      const timezone = task.timezone || DEFAULT_TIMEZONE;
      const onTick = () => this.executeTask(task);
      // Issue #4218 (fix A): use the injected job factory when provided so tests
      // can run deterministically (no real OS timer). Default = real CronJob,
      // auto-started (production behavior unchanged).
      const job: SchedulerJob = this.jobFactory
        ? this.jobFactory(task.cron, onTick, timezone)
        : new CronJob(task.cron, onTick, null, true, timezone);

      this.activeJobs.set(task.id, { taskId: task.id, job, task });
      logger.info({ taskId: task.id, cron: task.cron, name: task.name, timezone }, 'Scheduled task');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isCronError = errorMsg.toLowerCase().includes('cron');
      logger.error(
        { err: error, taskId: task.id, cron: task.cron, timezone: task.timezone || DEFAULT_TIMEZONE },
        isCronError ? 'Invalid cron expression' : 'Failed to schedule task (check cron expression and timezone)'
      );
    }
  }

  /**
   * Resolve the drain promise if no tasks are running.
   * Extracted to avoid duplication between stale-job cleanup and finally block.
   */
  private resolveDrainIfNeeded(): void {
    if (this.runningTasks.size === 0 && this._drainResolve) {
      this._drainResolve();
      this._drainPromise = null;
      this._drainResolve = null;
    }
  }

  /**
   * Clean up task tracking state after a task finishes or is aborted.
   * Issue #4102: Also cleans up per-chatId blocking task tracking.
   */
  private cleanupTaskTracking(task: ScheduledTask): void {
    this.runningTasks.delete(task.id);
    if (task.blocking && task.chatId) {
      this.runningBlockingTaskChatIds.delete(task.chatId);
    }
  }

  /**
   * Remove a task from the scheduler.
   *
   * @param taskId - Task ID to remove
   */
  removeTask(taskId: string): void {
    const entry = this.activeJobs.get(taskId);
    if (entry) {
      entry.job.stop();
      this.activeJobs.delete(taskId);
      logger.info({ taskId }, 'Removed scheduled task');
    }
  }

  /**
   * Build wrapped prompt with anti-recursion instructions.
   * Provides defense-in-depth against infinite recursion.
   *
   * @param task - Task being executed
   * @returns Wrapped prompt with explicit anti-recursion instructions
   */
  private buildScheduledTaskPrompt(task: ScheduledTask): string {
    return `⚠️ **Scheduled Task Execution Context**

You are executing a scheduled task named "${task.name}".

**IMPORTANT RULES:**
1. Do NOT create new scheduled tasks
2. Do NOT modify existing scheduled tasks
3. Focus on completing the task described below
4. If you need to run something periodically, report this need to the user instead

Scheduled task creation is blocked during scheduled task execution to prevent infinite recursion.

---

**Task Prompt:**
${task.prompt ?? ''}`;
  }

  /**
   * Issue #4648 residual ⑥: break a task's failure streak on success.
   * Routes through the injected TaskFailureStore when present (also clears
   * the persisted file), otherwise the in-memory fallback map.
   */
  private async clearFailureStreak(taskId: string): Promise<void> {
    if (this.failureStore) {
      await this.failureStore.recordSuccess(taskId);
      return;
    }
    this.consecutiveTaskFailures.delete(taskId);
  }

  /**
   * Issue #4648 residual ⑥: count a failure and return the new streak length.
   * The store path restores any streak persisted by previous process
   * lifetimes before incrementing (lazy init on first use).
   *
   * (Non-async on purpose: the in-memory fallback branch is synchronous, and
   * an `async` keyword there trips require-await.)
   */
  private recordTaskFailure(taskId: string): Promise<number> {
    if (this.failureStore) {
      return this.failureStore.recordFailure(taskId);
    }
    const streak = (this.consecutiveTaskFailures.get(taskId) ?? 0) + 1;
    this.consecutiveTaskFailures.set(taskId, streak);
    return Promise.resolve(streak);
  }

  /**
   * Execute a scheduled task.
   * Called by cron job when the schedule triggers.
   *
   * Issue #3582: Routes task through InputMessageRouter to existing agents.
   * Issue #869: Added cooldown period check before execution.
   * Issue #3894: Added timeout protection for route execution.
   *
   * @param task - Task to execute
   */
  private async executeTask(task: ScheduledTask): Promise<void> {
    // Issue #869: Check cooldown period first
    if (task.cooldownPeriod && this.cooldownManager) {
      const isInCooldown = await this.cooldownManager.isInCooldown(task.id, task.cooldownPeriod);
      if (isInCooldown) {
        const status = await this.cooldownManager.getCooldownStatus(task.id, task.cooldownPeriod);
        const remainingMinutes = Math.ceil(status.remainingMs / 60000);

        logger.info(
          { taskId: task.id, name: task.name, remainingMinutes },
          'Task skipped - in cooldown period'
        );

        // Send cooldown notification
        await this.callbacks.sendMessage(
          task.chatId,
          `⏰ 定时任务「${task.name}」冷静期中，跳过执行\n` +
          `   上次执行: ${status.lastExecutionTime?.toLocaleString('zh-CN')}\n` +
          `   冷静期结束: ${status.cooldownEndsAt?.toLocaleString('zh-CN')}\n` +
          `   剩余时间: ${remainingMinutes} 分钟`
        );
        return;
      }
    }

    // Check blocking mechanism
    if (task.blocking && (this.runningTasks.has(task.id) || this.isolatedBlockingTurns.has(task.id))) {
      logger.info(
        { taskId: task.id, name: task.name },
        'Task skipped - previous execution still running'
      );
      return;
    }

    // Issue #4102: Check if another blocking scheduled task is running for this chatId.
    // Previously used isAgentBusy() which also blocked on user-initiated conversations,
    // causing scheduled tasks to be indefinitely skipped in active chats.
    // Now we only block on OTHER scheduled blocking tasks for the same chatId.
    if (task.blocking && task.chatId && (this.runningBlockingTaskChatIds.has(task.chatId) || [...this.isolatedBlockingTurns.values()].includes(task.chatId))) {
      logger.info(
        { taskId: task.id, name: task.name, chatId: task.chatId },
        'Task skipped - another blocking scheduled task is running for this chatId'
      );
      return;
    }

    // A scheduled task should not be dispatched into a chat whose agent is
    // currently processing a message — that would interrupt / interleave with
    // the in-flight conversation. `isChatBusy` reflects the real
    // `isProcessingMessage` signal (non-sticky since #3985), so this gate skips
    // only this tick and lets the next cron tick retry after the chat is idle.
    // When no `isChatBusy` callback is wired, behavior is unchanged.
    if (task.chatId && this.callbacks.isChatBusy?.(task.chatId)) {
      logger.info(
        { taskId: task.id, name: task.name, chatId: task.chatId },
        'Task skipped - chat is busy (agent is processing a message)'
      );
      return;
    }

    logger.info({ taskId: task.id, name: task.name }, 'Executing scheduled task');

    // Mark task as running
    this.runningTasks.add(task.id);
    // Issue #4102: Track blocking tasks by chatId for per-chat serialization
    if (task.blocking && task.chatId) {
      this.runningBlockingTaskChatIds.add(task.chatId);
    }
    // Create drain promise if this is the first running task
    if (!this._drainPromise) {
      this._drainPromise = new Promise<void>((resolve) => {
        this._drainResolve = resolve;
      });
    }

    // Issue #3929: Verify the schedule file still exists before executing.
    // Placed after runningTasks.add() so that the blocking mechanism still
    // works synchronously. fs.watch may miss deletion events on Linux and
    // the periodic fullRescan may not have run yet.
    try {
      const currentTask = await this.scheduleManager.get(task.id);
      if (!currentTask) {
        logger.info(
          { taskId: task.id, name: task.name },
          'Task file no longer exists, removing stale cron job'
        );
        this.cleanupTaskTracking(task);
        this.removeTask(task.id);
        this.resolveDrainIfNeeded();
        return;
      }
    } catch (error) {
      logger.error(
        { err: error, taskId: task.id },
        'Failed to verify schedule file existence, skipping execution'
      );
      this.cleanupTaskTracking(task);
      this.removeTask(task.id);
      this.resolveDrainIfNeeded();
      return;
    }

    // Issue #4648: elapsed-time anchor for the truthful completion/failure
    // logs below (previously "completed" was logged at routing time, ~0.3s
    // BEFORE the agent even produced its first token).
    const taskStartedAt = Date.now();

    try {
      if ((!task.prompt && !task.command) || (task.prompt && task.command)) {
        throw new Error('Schedule task must define exactly one of prompt or command');
      }

      if (task.command) {
        await this.callbacks.sendMessage(task.chatId, `⏰ 定时任务「${task.name}」开始执行命令...`);
        logger.debug({ taskId: task.id, chatId: task.chatId }, 'Executing scheduled task command');
        const controller = new AbortController();
        this.activeCommandControllers.set(task.id, controller);
        let result: CommandExecutionResult;
        try {
          result = await this.commandRunner(task.command, {
            timeoutMs: task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
            env: {
            ...process.env,
            DISCLAUDE_SCHEDULE_ID: task.id,
            DISCLAUDE_SCHEDULE_NAME: task.name,
            DISCLAUDE_CHAT_ID: task.chatId,
            },
            signal: controller.signal,
          });
        } finally {
          this.activeCommandControllers.delete(task.id);
        }
        await this.clearFailureStreak(task.id);
        logger.info({
          taskId: task.id,
          name: task.name,
          chatId: task.chatId,
          elapsedMs: Date.now() - taskStartedAt,
          stdout: result.stdout,
          stderr: result.stderr,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
        }, 'Scheduled command completed');
        return;
      }

      // Build wrapped prompt with anti-recursion instructions
      const wrappedPrompt = this.buildScheduledTaskPrompt(task);

      // Issue #3582: Route through InputMessageRouter
      if (!this.inputMessageRouter || !task.chatId || !task.prompt) {
        logger.warn(
          { taskId: task.id, hasRouter: !!this.inputMessageRouter, hasChatId: !!task.chatId },
          'Cannot execute scheduled task: InputMessageRouter not configured or task has no chatId'
        );
        await this.callbacks.sendMessage(
          task.chatId,
          `⚠️ 定时任务「${task.name}」无法执行: InputMessageRouter 未配置或任务缺少 chatId`
        );
        return;
      }

      const freshSession = task.freshSession ?? (task.clearContext === false ? false : true);
      const skipHistory = task.skipHistory ?? task.clearContext === true;
      if (!freshSession && (skipHistory || task.model)) {
        throw new Error('History/model overrides require freshSession:true');
      }
      if ((!freshSession && skipHistory) || (task.clearContext === true && (!freshSession || !skipHistory))) {
        throw new Error('Conflicting schedule context options: skipHistory/clearContext:true require freshSession:true');
      }

      // Send start notification
      await this.callbacks.sendMessage(
        task.chatId,
        `⏰ 定时任务「${task.name}」开始执行...`
      );

      {
        const systemMessage: SystemMessage = {
          id: `sched-${task.id}-${randomUUID()}`,
          source: 'system',
          payload: wrappedPrompt,
          chatId: task.chatId,
          trigger: 'scheduled',
          taskName: task.name,
          ...(freshSession ? { agentSession: { id: `execution:${randomUUID()}`, skipHistory, model: task.model, releaseAfterTurn: true } } : {}),
          data: {
            taskId: task.id,
            createdBy: task.createdBy,
            model: task.model,
          },
          createdAt: new Date().toISOString(),
          // Issue #4648: await the agent turn's REAL outcome. The
          // waitForCompletion plumbing (#4063, built for the Loop Runner)
          // makes route() resolve only after the ChatAgent's per-turn
          // promise settles — and reject when the turn dies (startup
          // failure, iterator error). Without it, route() resolved the
          // moment processMessage QUEUED the prompt, so "completed" was
          // logged before the agent did any work and a session that died
          // 9s later was indistinguishable from a healthy run for 38 days.
          // The #3894 timeout above still bounds this wait. Issue #4649
          // (review ②): a timeout is a NEUTRAL outcome (the turn is not
          // cancelled and may still finish — see the TaskTimeoutError
          // branch in the catch); long-running tasks should set timeoutMs.
          waitForCompletion: true,
        };

        logger.debug({ taskId: task.id, chatId: task.chatId }, 'Routing scheduled task via InputMessageRouter');

        // Issue #3894: Timeout protection for InputMessageRouter route.
        // Prevents hung routes from keeping task in runningTasks forever.
        const timeoutMs = task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new TaskTimeoutError(task.id, timeoutMs)), timeoutMs);
        });
        try {
          const turn = this.inputMessageRouter.route(systemMessage);
          if (freshSession && task.blocking) {
            this.isolatedBlockingTurns.set(task.id, task.chatId);
            // Observe both outcomes without creating an unhandled rejection.
            void turn.then(
              () => { this.isolatedBlockingTurns.delete(task.id); },
              () => { this.isolatedBlockingTurns.delete(task.id); },
            );
          }
          await Promise.race([
            turn,
            timeoutPromise,
          ]);
        } finally {
          if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
          }
        }

        // Issue #4648: this log is now written only after the agent turn
        // actually finished (see waitForCompletion above) — the task's real
        // end state, not its routing ack. Issue #4648 residual ⑥: a healthy
        // run breaks the streak via the store/file path when wired.
        await this.clearFailureStreak(task.id);
        logger.info(
          {
            taskId: task.id,
            name: task.name,
            chatId: task.chatId,
            elapsedMs: Date.now() - taskStartedAt,
          },
          'Scheduled task completed (agent turn finished)'
        );
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const outcomeContext = {
        taskId: task.id,
        name: task.name,
        chatId: task.chatId,
        elapsedMs: Date.now() - taskStartedAt,
      };

      if (error instanceof TurnSupersededError) {
        // Issue #4649 (review ①): a newer message (typically a user reply
        // landing mid-turn in the same chat) superseded this turn's
        // completion promise. That is normal concurrency in an active chat,
        // not a task failure — the chat is demonstrably alive and the newer
        // message's turn runs in this turn's place:
        // - no ❌ notification (previously every interjection in a group
        //   chat spammed one, plus a false consecutive-failure count),
        // - streak deliberately untouched: a superseded run is neither
        //   evidence of health (resetting would mask real failures) nor of
        //   breakage,
        // - session cleanup belongs to the handler after its turn settles;
        //   never reset a user's agent in response to this wait outcome.
        //
        // Issue #4649 (review ③) note: with per-message turn completions an
        // ordinary interjection no longer produces this error at all (each
        // awaiter now gets its own turn's real outcome — see
        // ChatAgent.createTurnCompletion). The remaining producer is the
        // same-messageId re-push guard (empty-turn replay), which is exactly
        // the neutral shape this branch describes.
        logger.info(
          outcomeContext,
          'Scheduled task turn superseded by a newer message (neutral — not counted as failure)',
        );
        return;
      }

      if (error instanceof CommandCancelledError) {
        logger.info(outcomeContext, 'Scheduled command cancelled during scheduler shutdown (neutral)');
        return;
      }

      if (error instanceof TaskTimeoutError) {
        // Issue #4649 (review ②): this timeout bounds the WAIT — the agent
        // is not cancelled (#4648 wording), so the outcome is UNKNOWN: the
        // turn may still complete successfully after the bound. Counting it
        // as failure made every legitimately-long task a guaranteed ❌ and,
        // past the alert threshold, a false chronic-failure alarm. So:
        // - streak untouched (a slow task must neither mask real failures
        //   nor fake them); genuinely stuck turns are caught earlier by the
        //   pool's busy-turn hard cap and land here as countable REAL
        //   errors (see DEFAULT_TASK_TIMEOUT_MS),
        // - the handler retains its session until the actual turn settles;
        //   this wait timeout must not dispose a turn that may still run,
        // - the notification keeps the honest wording and teaches the knob.
        logger.warn(
          { ...outcomeContext, timeoutMs: error.timeoutMs },
          'Scheduled task timed out waiting for the agent turn (turn not cancelled, outcome unknown — not counted as failure)',
        );
        // Issue #4648 residual ⑧: channel I/O inside a catch must not throw —
        // a Feishu send failing here would replace the handled timeout and
        // reject executeTask past the fire-and-forget cron onTick (unhandled
        // rejection). The notification is best-effort.
        try {
          await this.callbacks.sendMessage(
            task.chatId,
            `⏱️ 定时任务「${task.name}」执行超时 (${formatTimeout(error.timeoutMs)})，已停止等待` +
              '（agent 轮次可能仍在后台继续）。若该任务确需更长运行时间，请在 SCHEDULE.md 设置 timeoutMs。',
          );
        } catch (notifyErr) {
          logger.warn(
            { err: notifyErr, taskId: task.id, chatId: task.chatId },
            'Failed to send timeout notification for scheduled task',
          );
        }
        return;
      }

      // Issue #4648: track consecutive failures per task. With
      // waitForCompletion the turn's real outcome now lands here — including
      // the "Iterator error"-class deaths that previously surfaced as an
      // instant "completed" — so a failing streak is finally countable.
      // Issue #4648 residual ⑥: via the injected store the streak also
      // survives restarts, so a crash loop still crosses the threshold.
      const consecutiveFailures = await this.recordTaskFailure(task.id);
      const failureContext = {
        ...outcomeContext,
        consecutiveFailures,
      };
      logger.error(
        { err: error, ...failureContext },
        'Scheduled task failed (agent turn ended with an error)'
      );
      if (consecutiveFailures >= CONSECUTIVE_FAILURE_ALERT_THRESHOLD) {
        // Issue #4648: dedicated alertable marker — a task failing this many
        // runs in a row is chronic (bad chatId, broken prompt environment,
        // persistent upstream errors) and deserves to stand out in log
        // search beyond the per-run failure stream.
        logger.error(
          { ...failureContext, scheduleConsecutiveFailures: consecutiveFailures },
          `Scheduled task has failed ${consecutiveFailures} consecutive runs — ` +
            'check its chatId / agent health (Issue #4648 alert)'
        );
      }

      // The handler owns isolated-agent cleanup. Never reset the user's live
      // chat here, including when a scheduled turn fails before startup.

      // Timeout notifications are handled in the TaskTimeoutError branch
      // above (Issue #4649 review ②: timeout is an unknown outcome, not a
      // failure); only real turn errors reach this ❌.
      //
      // Issue #4648 residual ⑧: channel I/O inside a catch must not throw —
      // a Feishu send failing here (WS reconnect window, bad chatId) would
      // replace the already-handled failure and reject executeTask past the
      // fire-and-forget cron onTick, i.e. an unhandled rejection. The
      // failure itself is fully logged above; the notification is
      // best-effort.
      try {
        await this.callbacks.sendMessage(
          task.chatId,
          `❌ 定时任务「${task.name}」执行失败: ${errorMessage}`
        );
      } catch (notifyErr) {
        logger.warn(
          { err: notifyErr, taskId: task.id, chatId: task.chatId },
          'Failed to send failure notification for scheduled task',
        );
      }
    } finally {
      // Always remove from running tasks
      this.cleanupTaskTracking(task);

      // Resolve drain promise when all tasks have completed
      this.resolveDrainIfNeeded();

      // Issue #869: Record execution for cooldown period
      if (task.cooldownPeriod && this.cooldownManager) {
        await this.cooldownManager.recordExecution(task.id, task.cooldownPeriod);
        logger.debug({ taskId: task.id, cooldownPeriod: task.cooldownPeriod }, 'Recorded task execution for cooldown');
      }
    }
  }

  /**
   * Get all active jobs.
   */
  getActiveJobs(): ActiveJob[] {
    return Array.from(this.activeJobs.values());
  }

  /**
   * Check if scheduler is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Check if a task is currently being executed.
   *
   * @param taskId - Task ID to check
   * @returns true if the task is currently running
   */
  isTaskRunning(taskId: string): boolean {
    return this.runningTasks.has(taskId);
  }

  /**
   * Check if any scheduled task is currently being executed.
   * Used to prevent recursive schedule creation.
   *
   * @returns true if any scheduled task is currently running
   */
  isAnyTaskRunning(): boolean {
    return this.runningTasks.size > 0;
  }

  /**
   * Get the IDs of all currently running tasks.
   *
   * @returns Array of running task IDs
   */
  getRunningTaskIds(): string[] {
    return Array.from(this.runningTasks);
  }

  /**
   * Get cooldown status for a task.
   *
   * @param taskId - Task ID to check
   * @param cooldownPeriod - Cooldown period in milliseconds
   * @returns Cooldown status or null if not applicable
   */
  async getCooldownStatus(taskId: string, cooldownPeriod?: number): Promise<{
    isInCooldown: boolean;
    lastExecutionTime: Date | null;
    cooldownEndsAt: Date | null;
    remainingMs: number;
  } | null> {
    if (!this.cooldownManager) { return null; }
    return await this.cooldownManager.getCooldownStatus(taskId, cooldownPeriod);
  }

  /**
   * Clear cooldown for a task (for debugging).
   *
   * @param taskId - Task ID to clear cooldown for
   * @returns true if cooldown was cleared, false otherwise
   */
  async clearCooldown(taskId: string): Promise<boolean> {
    if (!this.cooldownManager) { return false; }
    return await this.cooldownManager.clearCooldown(taskId);
  }

}
