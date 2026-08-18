/**
 * Voice Orchestrator — delegate router (design v0.3 §7).
 *
 * The secretary LLM IS the router: "delegate" is decided by whether the LLM
 * calls `delegate`, not by a separate intent classifier. This module is the
 * pure-logic landing of that contract — the SINGLE FREEZE trigger.
 *
 * MVP signature (pinned by design v0.3 §7):
 *   delegate({ task, eta_seconds? }) → task_id
 *
 *   - task        → frozen into a canonical snapshot (= the single FREEZE point)
 *   - eta_seconds → LLM self-reported estimate (mechanism ⑤), surfaced on the
 *                   same beat; carried on the task record, not the snapshot.
 *   - task_id     → indexes the delivery queue when a barg-in lands
 *
 * This layer owns promoteCandidate + freeze ONLY. Spawning the agent,
 * reporting the ETA out loud and delivery stay with later parts of #4152
 * (实现路线 第 1 步: 起 agent / 交付).
 */

import { randomUUID } from 'node:crypto';

import type { IntentSnapshotStore } from './store.js';
import type { Canonical, IntentFields } from './types.js';

/** Arguments the secretary LLM passes when it calls `delegate`. */
export interface DelegateRequest {
  /** Natural-language task statement; frozen verbatim as the canonical utterance. */
  task: string;
  /** Self-reported ETA in seconds (mechanism ⑤). Optional — MVP keeps it advisory. */
  etaSeconds?: number;
}

/** One delegated task: the frozen canonical plus the routing bookkeeping. */
export interface DelegatedTask {
  /** Indexes the delivery queue on barg-in (design §7: `task_id`). */
  taskId: string;
  /** The frozen canonical this task must run against — the single FREEZE output. */
  canonical: Canonical;
  /** Echoes the request's etaSeconds, if the LLM self-reported one. */
  etaSeconds?: number;
}

export interface DelegateRouterOptions {
  /** Injectable task-id factory for deterministic tests. Defaults to crypto UUID. */
  newTaskId?: () => string;
}

/** Thrown when `delegate` is called with an empty task. */
export class EmptyTaskError extends Error {
  constructor() {
    super('delegate() requires a non-empty task');
    this.name = 'EmptyTaskError';
  }
}

/** Thrown when `delegate` fires on a session that cannot be frozen (already frozen/delivered). */
export class NotFreezableError extends Error {
  constructor(public readonly phase: string) {
    super(`Session in phase "${phase}" cannot accept a new delegate task`);
    this.name = 'NotFreezableError';
  }
}

/**
 * Routes `delegate` calls onto the intent snapshot lifecycle: consolidates the
 * accumulated drafts into a candidate, then FREEZES it — the single point
 * where 草稿 → canonical happens (design §3-4). Stateless besides the store it
 * wraps, so it composes with either backing (in-memory or the file store).
 */
export class DelegateRouter {
  private readonly newTaskId: () => string;

  constructor(
    private readonly store: IntentSnapshotStore,
    opts: DelegateRouterOptions = {},
  ) {
    this.newTaskId = opts.newTaskId ?? randomUUID;
  }

  /**
   * The `delegate` tool body. Drafts accumulated by the background stream are
   * folded into a candidate carrying the delegated task, then frozen — callers
   * get the canonical the spawned agents must read. Deliberately synchronous:
   * the only async surface in this pipeline is the backing store's persistence.
   */
  delegate(sessionId: string, req: DelegateRequest): DelegatedTask {
    const task = req.task.trim();
    if (!task) {
      throw new EmptyTaskError();
    }

    // Refuse phases where a second FREEZE would violate the single-freeze-point
    // anchor, surfacing the store's phase instead of a generic error.
    const { phase } = this.store.getSession(sessionId);
    if (phase !== 'drafting' && phase !== 'candidate') {
      throw new NotFreezableError(phase);
    }

    const fields: IntentFields = { utterance: task };
    this.store.promoteCandidate(sessionId, fields);
    const canonical = this.store.freeze(sessionId);

    const delegated: DelegatedTask = { taskId: this.newTaskId(), canonical };
    if (req.etaSeconds !== undefined) {
      delegated.etaSeconds = req.etaSeconds;
    }
    return delegated;
  }
}
