/**
 * Voice Orchestrator — Intent Snapshot store (MVP foundation).
 *
 * Session-level store holding the full draft → candidate → canonical → results
 * lifecycle, enforcing the single FREEZE point (design v0.2 §3-4). The frozen
 * canonical is the only object N agents read; results are written to a separate
 * region and never mutate the intent.
 *
 * Persistence scope: session-level (in-memory map keyed by sessionId). A
 * production backing store (file/DB) can be layered behind the same interface;
 * M0 ships the in-memory implementation plus the contract.
 */

import { randomUUID } from 'node:crypto';
import { assertAllowed, type SnapshotEvent } from './state-machine.js';
import type {
  AgentResult,
  Candidate,
  Canonical,
  Draft,
  IntentFields,
  IntentSnapshot,
  ResultStatus,
  SnapshotPhase,
} from './types.js';

export interface IntentSnapshotStoreOptions {
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

export class IntentSnapshotStore {
  private readonly sessions = new Map<string, IntentSnapshot>();
  private readonly draftSeq = new Map<string, number>();
  private readonly now: () => number;

  constructor(opts: IntentSnapshotStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Create a fresh session in the drafting phase. */
  createSession(sessionId: string = randomUUID()): IntentSnapshot {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session already exists: ${sessionId}`);
    }
    const snapshot: IntentSnapshot = {
      sessionId,
      phase: 'drafting',
      drafts: [],
      candidate: null,
      canonical: null,
      results: [],
    };
    this.sessions.set(sessionId, snapshot);
    return this.clone(snapshot);
  }

  /** Append a draft from the background intent stream (mechanism ①). */
  appendDraft(sessionId: string, text: string, fields?: IntentFields): Draft {
    const snap = this.get(sessionId);
    this.guard(snap.phase, 'appendDraft');
    const seq = (this.draftSeq.get(sessionId) ?? 0) + 1;
    this.draftSeq.set(sessionId, seq);
    const draft: Draft = { seq, text, fields: structuredClone(fields), updatedAt: this.now() };
    snap.drafts.push(draft);
    return this.clone(draft);
  }

  /** Consolidate drafts into a candidate at a turn boundary. */
  promoteCandidate(sessionId: string, fields: IntentFields): Candidate {
    const snap = this.get(sessionId);
    this.guard(snap.phase, 'promoteCandidate');
    const candidate: Candidate = { fields: structuredClone(fields), createdAt: this.now() };
    snap.candidate = candidate;
    snap.phase = 'candidate';
    return this.clone(candidate);
  }

  /**
   * FREEZE — the SINGLE freeze point (design §4). Promotes the candidate to an
   * immutable canonical that N agents will read. Throws if already frozen.
   * `fields` overrides the candidate if supplied.
   */
  freeze(sessionId: string, fields?: IntentFields): Canonical {
    const snap = this.get(sessionId);
    this.guard(snap.phase, 'freeze');
    const canonical: Canonical = {
      // Clone on the way in: the caller-owned `fields` (or the live candidate
      // fields) must not stay aliased into the frozen canonical.
      fields: structuredClone(fields ?? snap.candidate?.fields ?? { utterance: '' }),
      frozenAt: this.now(),
    };
    snap.canonical = canonical;
    snap.phase = 'frozen';
    return this.clone(canonical);
  }

  /** Read the frozen canonical. Throws if not yet frozen. */
  getCanonical(sessionId: string): Canonical {
    const snap = this.get(sessionId);
    if (!snap.canonical || snap.phase === 'drafting' || snap.phase === 'candidate') {
      throw new Error(
        `Canonical not frozen for session ${sessionId} (phase=${snap.phase})`,
      );
    }
    return this.clone(snap.canonical);
  }

  /**
   * Append/update an agent's result in the results region (design §3). The
   * canonical intent is never touched. Updating an existing agentId merges in
   * place (status transitions pending → running → done/error).
   */
  appendResult(
    sessionId: string,
    agentId: string,
    status: ResultStatus,
    content?: string,
    error?: string,
  ): AgentResult {
    const snap = this.get(sessionId);
    this.guard(snap.phase, 'appendResult');
    const ts = this.now();
    const existing = snap.results.find((r) => r.agentId === agentId);
    if (existing) {
      existing.status = status;
      if (content !== undefined) {
        existing.content = content;
      }
      if (error !== undefined) {
        existing.error = error;
      }
      existing.updatedAt = ts;
      return this.clone(existing);
    }
    const result: AgentResult = {
      agentId,
      status,
      content,
      error,
      createdAt: ts,
      updatedAt: ts,
    };
    snap.results.push(result);
    return this.clone(result);
  }

  /** Mark the snapshot delivered (terminal for this session). */
  markDelivered(sessionId: string): void {
    const snap = this.get(sessionId);
    this.guard(snap.phase, 'markDelivered');
    snap.phase = 'delivered';
  }

  /** Read a defensive copy of a session snapshot. */
  getSession(sessionId: string): IntentSnapshot {
    return this.clone(this.get(sessionId));
  }

  // --- internals ---

  private get(sessionId: string): IntentSnapshot {
    const snap = this.sessions.get(sessionId);
    if (!snap) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return snap;
  }

  private guard(phase: SnapshotPhase, event: SnapshotEvent): void {
    assertAllowed(phase, event);
  }

  private clone<T extends Draft | Candidate | Canonical | AgentResult | IntentSnapshot>(snap: T): T {
    return structuredClone(snap);
  }
}
