/**
 * McpHealthTracker - Per-session health / circuit-breaker tracking for MCP tools.
 *
 * Issue #4179 (part 1): records consecutive failures per MCP tool and marks a
 * tool as degraded once it crosses a threshold (default 2, per the issue). A
 * degraded tool should be excluded from subsequent calls in the same session so
 * the agent pivots to alternatives instead of silently retrying a failing tool.
 *
 * This module is the **foundational primitive** for #4179 — the per-session
 * health tracker the issue's "Suggested Implementation" calls for. Wiring it
 * into the tool-result path (failure detection) and the degradation notice /
 * exclusion (the agent-facing behavior) is done in subsequent parts.
 *
 * Scope: session-only, in-memory. No persistence — degradation is meant to be
 * scoped to a single session and clears when the tracker (session) is discarded.
 *
 * @module @disclaude/core/agents
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('McpHealthTracker');

/** Per-tool health record. */
export interface ToolHealth {
  /** Consecutive failures since the last success. Resets to 0 on success. */
  consecutiveFailures: number;
  /** Lifetime failure count for this tool (observability; never reset on success). */
  totalFailures: number;
  /** True once fast-tripped or threshold crossed, until {@link McpHealthTracker.clear}. */
  degraded: boolean;
  /** ISO timestamp of the failure that tripped degradation (diagnostics). */
  degradedAt?: string;
}

/** Options for {@link McpHealthTracker}. */
export interface McpHealthTrackerOptions {
  /**
   * Consecutive failures before a tool is marked degraded. Default: `2`
   * (per #4179: "After 2 consecutive failures of the same MCP tool, mark it
   * as degraded").
   */
  degradationThreshold?: number;
  /**
   * Optional circuit-breaker fast-trip predicate. When it returns `true` for a
   * given failure, the tool is marked degraded **immediately**, regardless of
   * the consecutive-failure count (e.g. a connection error trips at once).
   */
  isFastTripFailure?: (toolName: string, error: unknown) => boolean;
  /** Injectable clock for deterministic tests. Defaults to real time. */
  now?: () => Date;
}

/** Default consecutive-failure count before a tool is marked degraded (#4179). */
const DEFAULT_DEGRADATION_THRESHOLD = 2;

/**
 * Per-session MCP tool health tracker (Issue #4179).
 *
 * Tracks consecutive failures per tool and marks a tool degraded once it
 * crosses {@link McpHealthTrackerOptions.degradationThreshold} consecutive
 * failures (default 2) or when the fast-trip predicate matches. A degraded tool
 * stays degraded for the rest of the session — per #4179, the agent should
 * "Stop retrying silently ... in the same session" — until explicitly cleared.
 */
export class McpHealthTracker {
  private readonly tools = new Map<string, ToolHealth>();
  private readonly degradationThreshold: number;
  private readonly isFastTripFailure?: (toolName: string, error: unknown) => boolean;
  private readonly now: () => Date;

  constructor(options: McpHealthTrackerOptions = {}) {
    // Floor at 1: a threshold ≤ 0 is a caller bug (would degrade before any
    // failure is even recorded). `Math.max(1, …)` keeps "first failure
    // degrades" semantics for a 0 input without going nonsensical on negatives.
    this.degradationThreshold = Math.max(
      1,
      options.degradationThreshold ?? DEFAULT_DEGRADATION_THRESHOLD,
    );
    this.isFastTripFailure = options.isFastTripFailure;
    this.now = options.now ?? (() => new Date());
  }

  /** Fetch-or-create the health record for a tool. */
  private record(toolName: string): ToolHealth {
    let rec = this.tools.get(toolName);
    if (!rec) {
      rec = { consecutiveFailures: 0, totalFailures: 0, degraded: false };
      this.tools.set(toolName, rec);
    }
    return rec;
  }

  /**
   * Record a failure for a tool. After {@link McpHealthTrackerOptions.degradationThreshold}
   * consecutive failures — or immediately when the fast-trip predicate matches —
   * the tool is marked degraded.
   */
  recordFailure(toolName: string, error?: unknown): void {
    const rec = this.record(toolName);
    rec.consecutiveFailures += 1;
    rec.totalFailures += 1;

    if (rec.degraded) {
      return;
    }

    const fastTrip = this.isFastTripFailure ? this.isFastTripFailure(toolName, error) : false;
    if (fastTrip || rec.consecutiveFailures >= this.degradationThreshold) {
      rec.degraded = true;
      rec.degradedAt = this.now().toISOString();
      logger.warn(
        {
          toolName,
          consecutiveFailures: rec.consecutiveFailures,
          fastTrip,
          threshold: this.degradationThreshold,
        },
        'MCP tool marked degraded (circuit open)',
      );
    }
  }

  /**
   * Record a success for a tool. Resets the consecutive-failure counter so a
   * tool that fails once then succeeds does not accumulate toward the threshold.
   *
   * Does **not** clear an already-tripped degraded state: per #4179 the agent
   * should "Stop retrying ... in the same session", so once degraded a tool
   * stays excluded for the session. Use {@link McpHealthTracker.clear} (single
   * tool) or {@link McpHealthTracker.reset} (all tools) for a fresh slate.
   */
  recordSuccess(toolName: string): void {
    const rec = this.tools.get(toolName);
    if (rec) {
      rec.consecutiveFailures = 0;
    }
  }

  /** True if the tool is currently degraded and should be excluded from calls. */
  isDegraded(toolName: string): boolean {
    return this.tools.get(toolName)?.degraded ?? false;
  }

  /**
   * Names of all currently-degraded tools, sorted for stable display (e.g. the
   * "以下 MCP 工具不可用: [...]" system reminder in a later part).
   */
  getDegradedTools(): string[] {
    const result: string[] = [];
    for (const [name, rec] of this.tools) {
      if (rec.degraded) {
        result.push(name);
      }
    }
    return result.sort();
  }

  /** Read-only health snapshot for a tool (observability), or `undefined` if unseen. */
  getHealth(toolName: string): ToolHealth | undefined {
    const rec = this.tools.get(toolName);
    return rec ? { ...rec } : undefined;
  }

  /** Manually trip a tool (e.g. operator override / known outage). */
  trip(toolName: string): void {
    const rec = this.record(toolName);
    if (!rec.degraded) {
      rec.degraded = true;
      rec.degradedAt = this.now().toISOString();
      logger.warn(
        { toolName, reason: 'manual', totalFailures: rec.totalFailures },
        'MCP tool marked degraded (manual trip)',
      );
    }
  }

  /** Clear degradation + counters for a single tool, allowing it to be retried again. */
  clear(toolName: string): void {
    this.tools.delete(toolName);
  }

  /** Reset all tool health (e.g. when a new session starts). */
  reset(): void {
    this.tools.clear();
  }
}
