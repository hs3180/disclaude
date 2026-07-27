/**
 * StreamingThrottle — per-session PATCH throttle for Card Kit streaming.
 *
 * Issue #4399 (#4208 P2-b): the streaming state machine drives `streamText`
 * PATCHes from the SDK event stream. PATCHes arrive faster than the Card Kit
 * rate limit allows, so they must be throttled per session. This is the
 * isolated, unit-testable throttle extracted from #4399 (the issue notes the
 * throttle is "intentionally isolated so the state logic + throttle are
 * reviewed independently").
 *
 * Replaces #4203's module-level thinking throttle with per-session scoping
 * (#4203 Not-in-scope item 2): one StreamingThrottle per active stream,
 * created on `startStreaming`, `finalize()`-d on `finalizeStreaming`.
 *
 * Semantics:
 * - **Leading + trailing**: the first `schedule()` emits immediately; rapid
 *   subsequent calls within `minIntervalMs` stash the latest content and emit
 *   it once at the trailing edge of the window (latest-wins, no queue buildup).
 * - **429 exponential backoff**: `note429()` doubles the effective interval
 *   (capped at `maxBackoffMs`); `noteSuccess()` resets it.
 * - **finalize()**: cancels the pending trailing timer to prevent leaks at
 *   session end. No further emissions after finalize.
 *
 * No caller wires this yet (the #4399 state machine is the consumer). Pure
 * utility — no dependency on #4395/#4396.
 */

export interface StreamingThrottleOptions {
  /** Minimum ms between emissions (leading + trailing window). Default 200. */
  minIntervalMs?: number;
  /** Cap for 429 exponential backoff (ms). Default 8000. */
  maxBackoffMs?: number;
  /** Override the timer impl (tests). Defaults to setTimeout/clearTimeout. */
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export class StreamingThrottle {
  private readonly minIntervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly emitFn: (content: string) => Promise<void> | void;
  private readonly now: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  private lastEmitMs: number;
  private backoffMs = 0;
  private trailingTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingContent: string | undefined;
  private finalized = false;

  constructor(
    emitFn: (content: string) => Promise<void> | void,
    options?: StreamingThrottleOptions,
  ) {
    this.emitFn = emitFn;
    this.minIntervalMs = options?.minIntervalMs ?? 200;
    this.maxBackoffMs = options?.maxBackoffMs ?? 8000;
    this.now = options?.now ?? (() => Date.now());
    this.setTimeoutFn = options?.setTimeout ?? setTimeout;
    this.clearTimeoutFn = options?.clearTimeout ?? clearTimeout;
    // Initialize so the very first schedule() emits immediately (leading):
    // elapsed = now - (-minIntervalMs) >= minIntervalMs ⇒ wait <= 0 ⇒ emit.
    this.lastEmitMs = -this.minIntervalMs;
  }

  /**
   * Schedule content for emission. Leading call emits immediately; rapid
   * subsequent calls within the window stash the latest and emit once at the
   * trailing edge (latest-wins).
   */
  schedule(content: string): void {
    if (this.finalized) {
      return;
    }
    const elapsed = this.now() - this.lastEmitMs;
    const interval = Math.max(this.minIntervalMs, this.backoffMs);
    const wait = interval - elapsed;
    if (wait <= 0) {
      this.emitNow(content);
    } else {
      // Trailing: stash latest content, (re)arm the trailing timer for the
      // remaining window. Only the most recent content is kept.
      this.pendingContent = content;
      this.clearTrailingTimer();
      this.trailingTimer = this.setTimeoutFn(() => {
        this.trailingTimer = undefined;
        if (this.finalized) {
          this.pendingContent = undefined;
          return;
        }
        if (this.pendingContent !== undefined) {
          const c = this.pendingContent;
          this.pendingContent = undefined;
          this.emitNow(c);
        }
      }, wait);
    }
  }

  /** Signal a 429 was received — exponential backoff (doubles, capped). */
  note429(): void {
    this.backoffMs =
      this.backoffMs === 0
        ? this.minIntervalMs * 2
        : Math.min(this.backoffMs * 2, this.maxBackoffMs);
  }

  /** Reset backoff after a successful PATCH (optional). */
  noteSuccess(): void {
    this.backoffMs = 0;
  }

  /** Current effective interval (for inspection / tests). */
  get effectiveIntervalMs(): number {
    return Math.max(this.minIntervalMs, this.backoffMs);
  }

  /**
   * Cancel the pending trailing timer. Called on `finalizeStreaming` to
   * prevent leaks. No further emissions occur after finalize().
   */
  finalize(): void {
    this.finalized = true;
    this.clearTrailingTimer();
    this.pendingContent = undefined;
  }

  private emitNow(content: string): void {
    this.lastEmitMs = this.now();
    this.pendingContent = undefined;
    // Fire-and-forget: the caller's emitFn (the PATCH) owns its own error
    // handling; the throttle's contract is purely about timing.
    void this.emitFn(content);
  }

  private clearTrailingTimer(): void {
    if (this.trailingTimer !== undefined) {
      this.clearTimeoutFn(this.trailingTimer);
      this.trailingTimer = undefined;
    }
  }
}
