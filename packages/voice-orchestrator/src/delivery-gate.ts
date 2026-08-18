/**
 * Voice Orchestrator — delivery pacing (mechanisms ⑤ + ⑥; issue 第 2 步 · 别烦人).
 *
 * Results are NEVER pushed the moment they are ready. They queue in the
 * snapshot's results region and are handed to the foreground only inside a
 * delivery window: a natural pause, the self-reported ETA elapsing (which
 * grants an interrupt), or the user explicitly asking — design v0.3 §1 ⑥:
 * [自然停顿 ∪ ETA 到点 ∪ 用户主动问].
 *
 * Mechanism ⑤ is enforced structurally, not by prompt discipline:
 *  - the ETA is announced once per session (a second announce is noise);
 *  - in-flight results (pending/running) are never delivered — the gate
 *    physically only hands over terminal results, so there is no
 *    "10%…30%…done" progress stream to build.
 *
 * Pure logic: wraps any IntentSnapshotStore, keeps no timers, reads `now`
 * only from the injected clock. ASR/VAD feeds the hints; TTS consumes the
 * decision. 半成品 (mechanism ③) delivery stays deferred per the issue's
 * 「以后」桶 — this gate paces complete results only.
 */

import type { IntentSnapshotStore } from './store.js';
import type { AgentResult, ResultStatus } from './types.js';

/** Result statuses that may be spoken aloud. Everything else is in-flight. */
const DELIVERABLE_STATUS: ReadonlySet<ResultStatus> = new Set<ResultStatus>(['done', 'error']);

export interface DeliveryGateOptions {
  /** The store holding the session snapshots this gate paces. */
  store: IntentSnapshotStore;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

/** Fresh observations from the foreground (VAD pause detection + user speech). */
export interface DeliveryHints {
  /** The user just went quiet — a natural pause was detected upstream. */
  naturalPause?: boolean;
  /** The user explicitly asked for the result (e.g. 「好了吗」). */
  userAsked?: boolean;
}

/** Why a delivery window opened. Mirrors design §1 ⑥'s three triggers. */
export type DeliveryReason = 'natural-pause' | 'eta-elapsed' | 'user-asked';

export interface DeliveryDecision {
  /** True when the queued results should be spoken now. */
  deliver: boolean;
  /** What opened (or keeps closed) the delivery window. */
  reason: DeliveryReason | 'nothing-ready' | 'waiting';
  /** Terminal results ready to speak. Empty unless `deliver`. */
  results: AgentResult[];
}

export class DeliveryGate {
  private readonly store: IntentSnapshotStore;
  private readonly now: () => number;
  private readonly etaAt = new Map<string, number>();

  constructor(opts: DeliveryGateOptions) {
    this.store = opts.store;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Record the one ETA announce (mechanism ⑤). Call right after FREEZE; the
   * returned deadline (epoch ms) is when interrupting the user becomes
   * acceptable. Throws on a second announce — silence after the first is the
   * whole point.
   */
  setEta(sessionId: string, etaSeconds: number): number {
    if (this.etaAt.has(sessionId)) {
      throw new Error(`ETA already announced for session ${sessionId}`);
    }
    if (!Number.isFinite(etaSeconds) || etaSeconds <= 0) {
      throw new Error(`etaSeconds must be a positive finite number, got ${etaSeconds}`);
    }
    const at = this.now() + etaSeconds * 1000;
    this.etaAt.set(sessionId, at);
    return at;
  }

  /**
   * Decide whether this is the moment to interrupt (mechanism ⑥). Pure read:
   * never mutates the store, so callers may poll it on every tick.
   */
  evaluate(sessionId: string, hints: DeliveryHints = {}): DeliveryDecision {
    const snap = this.store.getSession(sessionId);
    if (snap.phase === 'delivered') {
      return { deliver: false, reason: 'nothing-ready', results: [] };
    }
    const ready = snap.results.filter((r) => DELIVERABLE_STATUS.has(r.status));
    if (ready.length === 0) {
      return { deliver: false, reason: 'nothing-ready', results: [] };
    }
    // Trigger priority: an explicit ask outranks everything; a lapsed ETA
    // outranks a pause (the deadline alone would have opened the window).
    let reason: DeliveryReason;
    if (hints.userAsked) {
      reason = 'user-asked';
    } else if (this.now() >= (this.etaAt.get(sessionId) ?? Number.POSITIVE_INFINITY)) {
      reason = 'eta-elapsed';
    } else if (hints.naturalPause) {
      reason = 'natural-pause';
    } else {
      return { deliver: false, reason: 'waiting', results: [] };
    }
    return { deliver: true, reason, results: ready };
  }
}
