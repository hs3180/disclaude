/**
 * Voice Orchestrator — per-agent ResultSink (第 1 步主干 · agent 读写边界).
 *
 * A ResultSink is the narrow, structured surface one delegated agent gets:
 * it may read the frozen canonical (defensive copy — the intent is immutable
 * after FREEZE, design §4) and write its own result into the results region
 * (design §3, 结果写回独立区). It deliberately exposes nothing else from the
 * store: no drafts, no candidate, no other agents' rows, no delivery control
 * (that belongs to the foreground, e.g. a DeliveryGate).
 *
 * The sink maps a worker's outcome onto the ResultStatus lifecycle
 * (pending → running → done/error): `start()` claims the row, `complete()`
 * and `fail()` settle it. Settled rows stay settled — a late `fail()` after
 * `complete()` (or vice versa) throws rather than rewriting history, so the
 * delivery side never sees a result flip status after it acted on it.
 */

import type { IntentSnapshotStore } from './store.js';
import type { AgentResult, Canonical, ResultStatus } from './types.js';

/**
 * Thrown when a result row is written again in the status it already holds:
 * a second `start()` on a claimed (running) row, or any write after the row
 * settled (done/error). `running` is not settled, but both mean "do not write".
 */
export class ResultAlreadySettledError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly agentId: string,
    public readonly status: ResultStatus,
  ) {
    super(
      `Result for agent "${agentId}" in session "${sessionId}" is ${
        status === 'running'
          ? 'already claimed (running); settle it with complete() or fail()'
          : `already settled (${status}); results do not flip status after done/error`
      }`,
    );
    this.name = 'ResultAlreadySettledError';
  }
}

/** Thrown when a status transition is attempted out of order. */
export class InvalidResultStatusError extends Error {
  constructor(
    from: ResultStatus | 'absent',
    to: ResultStatus,
  ) {
    super(`Invalid result status transition: ${from} → ${to}`);
    this.name = 'InvalidResultStatusError';
  }
}

/**
 * Lifecycle: pending → running → done|error. `pending` exists so a delegate
 * router can reserve a row before the worker starts emitting; the sink starts
 * every row at `running` and workers normally go running → done|error.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<ResultStatus, ReadonlySet<ResultStatus>>> = {
  pending: new Set<ResultStatus>(['running', 'error']),
  running: new Set<ResultStatus>(['done', 'error']),
  done: new Set<ResultStatus>(),
  error: new Set<ResultStatus>(),
};

export interface ResultSinkOptions {
  /**
   * Injectable clock for deterministic tests. Defaults to Date.now. The sink
   * itself does not stamp time (the store does) — reserved for subclasses.
   */
  now?: () => number;
}

export class ResultSink {
  protected readonly now: () => number;

  constructor(
    private readonly store: IntentSnapshotStore,
    private readonly sessionId: string,
    private readonly agentId: string,
    opts: ResultSinkOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * The frozen canonical this agent works from. Returns a fresh defensive
   * copy on every call — callers cannot mutate the shared intent through it
   * (the store also clones, so this is belt-and-braces for the agent boundary).
   */
  getCanonical(): Canonical {
    return this.store.getCanonical(this.sessionId);
  }

  /** Phase of the underlying session, e.g. `frozen` while work is in flight. */
  get phase() {
    return this.store.getSession(this.sessionId).phase;
  }

  /** Claim this agent's row in the results region (status → running). */
  start(): AgentResult {
    return this.write('running');
  }

  /** Settle the row with a successful payload. */
  complete(content: string): AgentResult {
    return this.write('done', content);
  }

  /** Settle the row with an error. */
  fail(error: string): AgentResult {
    return this.write('error', undefined, error);
  }

  /** This agent's current result row, or null before `start()`. */
  getResult(): AgentResult | null {
    return (
      this.store.getSession(this.sessionId).results.find((r) => r.agentId === this.agentId) ??
      null
    );
  }

  // --- internals ---

  private write(status: ResultStatus, content?: string, error?: string): AgentResult {
    const existing = this.getResult();
    if (existing) {
      if (!ALLOWED_TRANSITIONS[existing.status].has(status)) {
        throw existing.status === status
          ? new ResultAlreadySettledError(this.sessionId, this.agentId, existing.status)
          : new InvalidResultStatusError(existing.status, status);
      }
    } else if (status !== 'running') {
      // A row must be claimed (running) before it can settle.
      throw new InvalidResultStatusError('absent', status);
    }
    return this.store.appendResult(this.sessionId, this.agentId, status, content, error);
  }
}
