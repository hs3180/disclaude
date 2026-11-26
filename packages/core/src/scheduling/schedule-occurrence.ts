/**
 * Schedule occurrence identity, enumeration and startup reconciliation.
 *
 * Issue #5763: a fixed-time periodic task whose original instant fell inside a
 * service restart left no trace — cron computes the NEXT fire time from the
 * restore instant, so the straddled occurrence is neither executed nor
 * recorded, and the existing failure/skip records only ever come from the
 * tick path. This module is the pure, I/O-free core of the ledger that makes
 * such occurrences queryable:
 *
 * - an occurrence is identified by `(taskId, scheduledFor)` where
 *   `scheduledFor` is the UTC instant of the cron fire time in the TASK's
 *   timezone (the zone is kept on the record so the instant can be re-derived
 *   and displayed with its offset);
 * - `enumerateOccurrences` walks cron forward over a lifecycle gap using the
 *   same `CronTime` the production CronJob uses (no timer is created);
 * - `reconcileStartup` compares that enumeration against what is already
 *   recorded. An occurrence is marked `missed` ONLY when both lifecycle
 *   boundaries are known (previous lifetime stopped before the instant, this
 *   lifetime started after it) and nothing records a fire; with a missing
 *   boundary the result is `unknown` with the gap reported — never silently
 *   promoted to a success or a definite failure;
 * - reconciliation is idempotent: a key already recorded is never registered
 *   again, so consecutive restarts do not duplicate one result.
 *
 * Persistence and the tick-path recording are layered on top of this module
 * (see the Scheduler wiring); nothing here reads or writes files.
 *
 * @module @disclaude/core/scheduling
 */

import { CronTime } from 'cron';
import { DEFAULT_TIMEZONE, type ScheduledTask } from './scheduled-task.js';

/**
 * Outcome of one scheduled occurrence.
 *
 * `executing` means the tick path admitted the run and its terminal state is
 * not yet known. `missed` requires sufficient occurrence AND lifecycle
 * evidence; `unknown` is the honest remainder (no stop record, interrupted
 * run, unavailable history).
 */
export type OccurrenceStatus =
  | 'pending'
  | 'executing'
  | 'skipped'
  | 'failed'
  | 'completed'
  | 'missed'
  | 'unknown';

/** Final delivery of the run's output/notice — deliberately separate from {@link OccurrenceStatus}. */
export type OccurrenceDelivery = 'not-applicable' | 'sent' | 'failed' | 'unknown';

/** One occurrence's recorded result. */
export interface OccurrenceRecord {
  taskId: string;
  /** Identity: original scheduled fire instant as UTC (ISO-8601, `Z`). */
  scheduledFor: string;
  /** Same instant rendered in the task timezone (offset visible), for display. */
  scheduledForLocal: string;
  /** IANA zone the task was scheduled in when this record was made. */
  timezone: string;
  /** Cron expression the record was derived from (a later config change must not rewrite history). */
  cron: string;
  status: OccurrenceStatus;
  delivery: OccurrenceDelivery;
  /** Why the status is what it is — the evidence an operator can audit. */
  evidence: string;
  /** When this record was last observed/written (ISO). */
  observedAt: string;
}

/** Stable identity of an occurrence across restarts. */
export function occurrenceKey(taskId: string, scheduledFor: string): string {
  return `${taskId}@${scheduledFor}`;
}

const definitionOf = (task: Pick<ScheduledTask, 'cron' | 'timezone'>) => task.timezone || DEFAULT_TIMEZONE;

/** Enumerated fire instant inside a lifecycle gap. */
export interface EnumeratedOccurrence {
  /** UTC instant (ISO, `Z`) — the identity component. */
  scheduledFor: string;
  /** Same instant in the task timezone (offset visible). */
  scheduledForLocal: string;
}

export interface EnumerateResult {
  occurrences: EnumeratedOccurrence[];
  /** True when {@link MAX_ENUMERATED_OCCURRENCES} cut the walk short. */
  truncated: boolean;
  /** Set when cron/timezone is invalid and nothing can be enumerated. */
  error?: 'invalid-definition';
}

/**
 * Upper bound on occurrences enumerated for one task over one gap. A
 * every-minute cron across a month-long outage would otherwise yield ~43k
 * records; the cut is reported, not hidden.
 */
export const MAX_ENUMERATED_OCCURRENCES = 5000;

/**
 * Enumerate the fire instants of `task` in the half-open interval
 * `(from, to]` — every instant after the previous lifetime stopped and no
 * later than this lifetime's start. Pure time arithmetic via `CronTime`; no
 * timer, job, agent or channel is touched.
 */
export function enumerateOccurrences(
  task: Pick<ScheduledTask, 'cron' | 'timezone'>,
  from: Date,
  to: Date,
): EnumerateResult {
  const timezone = definitionOf(task);
  const occurrences: EnumeratedOccurrence[] = [];
  if (!(from.getTime() < to.getTime())) { return { occurrences, truncated: false }; }
  let cronTime: CronTime;
  try {
    cronTime = new CronTime(task.cron, timezone);
  } catch {
    return { occurrences, truncated: false, error: 'invalid-definition' };
  }
  // cron has one-second resolution: anything within `from`'s second is not
  // "after" it. +1ms lands in the next second, which CronTime normalizes.
  let cursor = new Date(from.getTime() + 1);
  while (occurrences.length < MAX_ENUMERATED_OCCURRENCES) {
    let next: Date;
    let nextLocal: string;
    try {
      // Zone must be passed explicitly: `getNextDateFrom` walks in the system
      // zone otherwise. `sendAt()` does the same `setZone(this.timeZone)` before
      // walking, so this matches the production CronJob's next-fire arithmetic.
      const dateTime = cronTime.getNextDateFrom(cursor, timezone);
      next = dateTime.toJSDate();
      nextLocal = dateTime.toISO() ?? next.toISOString();
    } catch {
      // cron throws when no fire time exists within 8 years (e.g. a dated
      // one-shot that already passed) — that is an empty remainder, not an error.
      break;
    }
    if (next.getTime() > to.getTime()) { break; }
    occurrences.push({ scheduledFor: next.toISOString(), scheduledForLocal: nextLocal });
    cursor = new Date(next.getTime() + 1000);
  }
  return { occurrences, truncated: occurrences.length >= MAX_ENUMERATED_OCCURRENCES };
}

/**
 * Lifecycle boundaries the reconciliation runs against.
 *
 * `previousStoppedAt` is only present when the previous lifetime recorded a
 * clean stop. A crash, kill or power loss leaves it undefined — then the gap
 * has no lower bound and straddled occurrences cannot be proven missed.
 */
export interface LifecycleEvidence {
  previousStoppedAt?: string;
  /** Instant this lifetime began loading tasks (before any CronJob existed). */
  startedAt: string;
}

/** An evidence gap that prevents a definite classification; reported, never hidden. */
export interface ReconcileGap {
  taskId: string;
  code:
    | 'no-stop-evidence'
    | 'inconsistent-lifecycle-evidence'
    | 'invalid-definition'
    | 'occurrence-cap';
  detail: string;
}

export interface ReconcileInput {
  /** Currently loaded tasks; disabled tasks are not expected to fire and are skipped. */
  tasks: Pick<ScheduledTask, 'id' | 'cron' | 'timezone' | 'enabled'>[];
  evidence: LifecycleEvidence;
  /** Known records keyed by {@link occurrenceKey}. */
  records: Map<string, OccurrenceRecord>;
  now?: Date;
}

export interface ReconcileResult {
  /** Records to persist for straddled occurrences proven missed. Empty when nothing is provable. */
  additions: OccurrenceRecord[];
  /** Re-written records whose `executing` run was cut off by the end of a previous lifetime. */
  interrupted: OccurrenceRecord[];
  gaps: ReconcileGap[];
}

/**
 * Evidence code carried by every `missed` record. The instants are enumerated
 * under the task's CURRENT cron/timezone: if the definition (or its enabled
 * state) was edited during the lifecycle gap, the set of fire instants that
 * existed back then is not knowable from here — the record says so instead of
 * presenting the enumeration as exact.
 */
const MISSED_EVIDENCE =
  'previous-lifetime-stopped-before-and-this-started-after-instant'
  + ' (enumerated under the current cron/timezone; definition changes during the gap are not knowable)';

/**
 * Startup reconciliation (Issue #5763): walk each enabled task over the
 * lifecycle gap and register only what is provable.
 *
 * - a recorded key is left untouched (idempotent across consecutive restarts);
 * - an unrecorded instant strictly between a known stop and a later start is
 *   `missed` — neither lifetime had a CronJob at that instant;
 * - without a known stop the gap is unbounded → `unknown`, reported as a gap;
 * - a record still `executing` from a previous lifetime is `unknown` (the
 *   run was interrupted; its real outcome is not recoverable here).
 *
 * Nothing here schedules a catch-up or re-executes business: the result is a
 * ledger entry for the read-only query, under the existing notification policy.
 */
export function reconcileStartup(input: ReconcileInput): ReconcileResult {
  const now = input.now ?? new Date();
  const observedAt = now.toISOString();
  const startedAtMs = Date.parse(input.evidence.startedAt);
  const stoppedAtMs = input.evidence.previousStoppedAt === undefined
    ? NaN
    : Date.parse(input.evidence.previousStoppedAt);
  const additions: OccurrenceRecord[] = [];
  const interrupted: OccurrenceRecord[] = [];
  const gaps: ReconcileGap[] = [];

  for (const task of input.tasks) {
    if (!task.enabled) { continue; }
    const timezone = definitionOf(task);

    for (const record of input.records.values()) {
      if (record.taskId !== task.id || record.status !== 'executing') { continue; }
      if (Date.parse(record.observedAt) < startedAtMs) {
        interrupted.push({
          ...record,
          status: 'unknown',
          evidence: 'previous-lifetime-ended-while-executing',
          observedAt,
        });
      }
    }

    if (Number.isNaN(stoppedAtMs)) {
      gaps.push({ taskId: task.id, code: 'no-stop-evidence', detail: 'previous lifetime recorded no clean stop; straddled occurrences cannot be bounded' });
      continue;
    }
    if (stoppedAtMs >= startedAtMs) {
      gaps.push({ taskId: task.id, code: 'inconsistent-lifecycle-evidence', detail: `stop ${input.evidence.previousStoppedAt} not before start ${input.evidence.startedAt}` });
      continue;
    }
    const enumerated = enumerateOccurrences(task, new Date(stoppedAtMs), new Date(startedAtMs));
    if (enumerated.error) {
      gaps.push({ taskId: task.id, code: 'invalid-definition', detail: `cron "${task.cron}" or timezone "${timezone}" is invalid` });
      continue;
    }
    if (enumerated.truncated) {
      gaps.push({ taskId: task.id, code: 'occurrence-cap', detail: `gap yielded more than ${MAX_ENUMERATED_OCCURRENCES} occurrences; remainder not registered` });
    }
    for (const occurrence of enumerated.occurrences) {
      const key = occurrenceKey(task.id, occurrence.scheduledFor);
      if (input.records.has(key)) { continue; }
      additions.push({
        taskId: task.id,
        scheduledFor: occurrence.scheduledFor,
        scheduledForLocal: occurrence.scheduledForLocal,
        timezone,
        cron: task.cron,
        status: 'missed',
        delivery: 'not-applicable',
        evidence: MISSED_EVIDENCE,
        observedAt,
      });
    }
  }
  return { additions, interrupted, gaps };
}

export interface OccurrenceLookup {
  taskId: string;
  /** Original scheduled instant (UTC ISO). */
  scheduledFor: string;
  /** Task definition to validate the instant against; omit to trust the instant. */
  task?: Pick<ScheduledTask, 'cron' | 'timezone'>;
  records: Map<string, OccurrenceRecord>;
  evidence: LifecycleEvidence;
  now?: Date;
}

/**
 * Read-only classification of ONE occurrence by task ID and original instant.
 * Returns the stored record when there is one, otherwise the honest derived
 * status: `pending` before the instant, `missed` when both lifecycle
 * boundaries bracket it, `unknown` otherwise.
 */
export function classifyOccurrence(lookup: OccurrenceLookup): OccurrenceRecord {
  const now = lookup.now ?? new Date();
  const timezone = lookup.task ? definitionOf(lookup.task) : DEFAULT_TIMEZONE;
  const base = {
    taskId: lookup.taskId,
    scheduledFor: lookup.scheduledFor,
    scheduledForLocal: lookup.scheduledFor,
    timezone,
    cron: lookup.task?.cron ?? '',
    delivery: 'not-applicable' as OccurrenceDelivery,
    observedAt: now.toISOString(),
  };
  const key = occurrenceKey(lookup.taskId, lookup.scheduledFor);
  const recorded = lookup.records.get(key);
  if (recorded) {
    return Date.parse(recorded.observedAt) < Date.parse(lookup.evidence.startedAt) && recorded.status === 'executing'
      ? { ...recorded, status: 'unknown', evidence: 'previous-lifetime-ended-while-executing', observedAt: base.observedAt }
      : recorded;
  }
  const instantMs = Date.parse(lookup.scheduledFor);
  if (Number.isNaN(instantMs)) {
    return { ...base, status: 'unknown', evidence: 'scheduled-instant-unparseable' };
  }
  if (instantMs > now.getTime()) { return { ...base, status: 'pending', evidence: 'not-yet-due' }; }
  const stoppedAtMs = lookup.evidence.previousStoppedAt === undefined ? NaN : Date.parse(lookup.evidence.previousStoppedAt);
  const startedAtMs = Date.parse(lookup.evidence.startedAt);
  if (!Number.isNaN(stoppedAtMs) && stoppedAtMs < instantMs && instantMs <= startedAtMs) {
    return { ...base, status: 'missed', evidence: MISSED_EVIDENCE };
  }
  if (instantMs > startedAtMs) {
    return { ...base, status: 'unknown', evidence: 'no-record-for-instant-inside-current-lifetime' };
  }
  return { ...base, status: 'unknown', evidence: 'no-record-and-no-clean-stop-boundary' };
}
