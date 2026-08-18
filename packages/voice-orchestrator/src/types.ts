/**
 * Voice Orchestrator — Intent Snapshot data model.
 *
 * The intent snapshot is the SINGLE handoff object between the background
 * (always-listening intent stream) and the foreground (frozen canonical that
 * N agents read; results region they write back). See design v0.2 §3.
 *
 * Lifecycle: drafting → candidate → canonical(FREEZE) → results[] → delivered
 */

/** Phase of a session's intent snapshot. Drives every state-machine guard. */
export type SnapshotPhase = 'drafting' | 'candidate' | 'frozen' | 'delivered';

/** Intent fields, intentionally loose for v0.2 (parsed upstream by the daemon). */
export interface IntentFields {
  /** Natural-language statement of what the user wants. */
  utterance: string;
  /** Optional structured slots (key/value) extracted by the intent stream. */
  slots?: Record<string, string>;
}

/**
 * Draft — written continuously by the background intent stream while listening
 * (mechanism ①). Many drafts accumulate during the drafting phase; each is an
 * incremental best guess, not authoritative.
 */
export interface Draft {
  seq: number;
  text: string;
  fields?: IntentFields;
  /** epoch ms */
  updatedAt: number;
}

/**
 * Candidate — formed at a turn boundary (e.g. natural pause) by consolidating
 * drafts. Promoted to canonical only at FREEZE.
 */
export interface Candidate {
  fields: IntentFields;
  /** epoch ms */
  createdAt: number;
}

/**
 * Canonical — the FROZEN intent. Immutable after FREEZE. This is the single
 * freeze point and the only object N agents read (design §4 单一冻结点).
 */
export interface Canonical {
  fields: IntentFields;
  /** epoch ms */
  frozenAt: number;
}

/** Status of an individual agent's contribution to the results region. */
export type ResultStatus = 'pending' | 'running' | 'done' | 'error';

/**
 * Result — one agent's output, written to the results region. Agents must never
 * mutate the canonical intent; results live in their own region (design §3).
 */
export interface AgentResult {
  agentId: string;
  status: ResultStatus;
  content?: string;
  error?: string;
  /** epoch ms */
  createdAt: number;
  /** epoch ms */
  updatedAt: number;
}

/** A session's full intent snapshot. */
export interface IntentSnapshot {
  sessionId: string;
  phase: SnapshotPhase;
  drafts: Draft[];
  candidate: Candidate | null;
  canonical: Canonical | null;
  results: AgentResult[];
}
