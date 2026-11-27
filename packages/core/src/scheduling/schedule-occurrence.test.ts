/**
 * Tests for schedule occurrence identity, enumeration and startup
 * reconciliation (Issue #5763).
 *
 * Fake clock throughout (`vi.setSystemTime`): the `CronTime` walk reads
 * `Date.now()` for its 8-year search bound, so the entire matrix — normal
 * tick, stop-before/restore-after, crash without stop evidence, interrupted
 * run, repeated start — runs without a real timer, scheduler, store, agent or
 * channel.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyOccurrence,
  enumerateOccurrences,
  occurrenceKey,
  reconcileStartup,
  MAX_ENUMERATED_OCCURRENCES,
  type OccurrenceRecord,
} from './schedule-occurrence.js';

const SHANGHAI = 'Asia/Shanghai';
const at = (iso: string) => new Date(iso);

/** `0 8 * * *` in Asia/Shanghai → 00:00Z. 2026-11-25 08:00 CST. */
const NOV25_0800_CST = '2026-11-25T00:00:00.000Z';
const NOV26_0800_CST = '2026-11-26T00:00:00.000Z';

const dailyEight = { id: 'morning-report', cron: '0 8 * * *', timezone: SHANGHAI, enabled: true };

function record(overrides: Partial<OccurrenceRecord>): OccurrenceRecord {
  return {
    taskId: 'morning-report',
    scheduledFor: NOV25_0800_CST,
    scheduledForLocal: '2026-11-25T08:00:00.000+08:00',
    timezone: SHANGHAI,
    cron: '0 8 * * *',
    status: 'completed',
    delivery: 'sent',
    evidence: 'tick-path-completed',
    observedAt: '2026-11-25T00:00:05.000Z',
    ...overrides,
  };
}

describe('enumerateOccurrences', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(at('2026-11-26T00:30:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('identity keeps the task timezone: 08:00 Asia/Shanghai is 00:00Z with a +08:00 local form', () => {
    const { occurrences } = enumerateOccurrences(dailyEight, at('2026-11-25T07:01:00+08:00'), at('2026-11-26T08:24:00+08:00'));
    expect(occurrences.map((o) => o.scheduledFor)).toEqual([NOV25_0800_CST, NOV26_0800_CST]);
    expect(occurrences[0].scheduledForLocal).toBe('2026-11-25T08:00:00.000+08:00');
    expect(occurrenceKey('morning-report', NOV25_0800_CST)).toBe(`morning-report@${NOV25_0800_CST}`);
  });

  it('honours a non-default timezone (08:00 America/New_York = 13:00Z in EST)', () => {
    const { occurrences } = enumerateOccurrences(
      { ...dailyEight, timezone: 'America/New_York' },
      at('2026-11-24T00:00:00Z'), at('2026-11-26T00:00:00Z'),
    );
    expect(occurrences.map((o) => o.scheduledFor)).toEqual(['2026-11-24T13:00:00.000Z', '2026-11-25T13:00:00.000Z']);
    expect(occurrences[0].scheduledForLocal).toBe('2026-11-24T08:00:00.000-05:00');
  });

  it('interval is (from, to]: an instant at the stop boundary is excluded, one at the start boundary included', () => {
    const excluded = enumerateOccurrences(dailyEight, at(NOV25_0800_CST), at(NOV26_0800_CST));
    expect(excluded.occurrences.map((o) => o.scheduledFor)).toEqual([NOV26_0800_CST]);
    const included = enumerateOccurrences(dailyEight, at('2026-11-25T00:00:00.001Z'), at(NOV26_0800_CST));
    expect(included.occurrences.map((o) => o.scheduledFor)).toEqual([NOV26_0800_CST]);
    const empty = enumerateOccurrences(dailyEight, at(NOV26_0800_CST), at(NOV26_0800_CST));
    expect(empty.occurrences).toEqual([]);
  });

  it('a dated (once-a-year) cron yields exactly one instant in a gap around it and none in a later gap', () => {
    // cron 3.x has no year field: `0 8 25 11 *` is the closest "single fire" a
    // schedule can declare — one instant per year on Nov 25 08:00 CST.
    const dated = { id: 'one-off', cron: '0 8 25 11 *', timezone: SHANGHAI, enabled: true };
    expect(enumerateOccurrences(dated, at('2026-11-25T07:00:00+08:00'), at('2026-11-25T08:30:00+08:00')).occurrences)
      .toEqual([{ scheduledFor: NOV25_0800_CST, scheduledForLocal: '2026-11-25T08:00:00.000+08:00' }]);
    const laterGap = enumerateOccurrences(dated, at('2026-11-25T08:30:00+08:00'), at('2026-11-27T00:00:00Z'));
    expect(laterGap.occurrences).toEqual([]);
    expect(laterGap.error).toBeUndefined();
    // A year field is rejected by this cron version → reported, not thrown.
    expect(enumerateOccurrences({ ...dated, cron: '0 8 25 11 * 2026' }, at('2026-11-25T07:00:00+08:00'), at('2026-11-25T08:30:00+08:00')).error)
      .toBe('invalid-definition');
  });

  it('reports an invalid cron or timezone instead of throwing', () => {
    expect(enumerateOccurrences({ ...dailyEight, timezone: 'Mars/Olympus' }, at('2026-11-25T00:00:00Z'), at('2026-11-26T00:00:00Z')))
      .toEqual({ occurrences: [], truncated: false, error: 'invalid-definition' });
    expect(enumerateOccurrences({ ...dailyEight, cron: 'not a cron' }, at('2026-11-25T00:00:00Z'), at('2026-11-26T00:00:00Z')).error)
      .toBe('invalid-definition');
  });

  it('caps a dense gap and says so rather than registering unbounded history', () => {
    const everyMinute = { id: 'chatty', cron: '* * * * *', timezone: SHANGHAI, enabled: true };
    const result = enumerateOccurrences(everyMinute, at('2026-10-01T00:00:00Z'), at('2026-11-26T00:00:00Z'));
    expect(result.occurrences).toHaveLength(MAX_ENUMERATED_OCCURRENCES);
    expect(result.truncated).toBe(true);
  });
});

describe('reconcileStartup', () => {
  const now = at('2026-11-25T08:24:00+08:00'); // 2026-11-25T00:24:00Z

  it('stop before the instant, restore after it: the straddled occurrence is registered as missed, once', () => {
    const evidence = { previousStoppedAt: '2026-11-24T23:01:00Z', startedAt: '2026-11-25T00:24:00Z' };
    const first = reconcileStartup({ tasks: [dailyEight], evidence, records: new Map(), now });
    expect(first.gaps).toEqual([]);
    expect(first.interrupted).toEqual([]);
    expect(first.additions).toHaveLength(1);
    expect(first.additions[0]).toMatchObject({
      taskId: 'morning-report',
      scheduledFor: NOV25_0800_CST,
      scheduledForLocal: '2026-11-25T08:00:00.000+08:00',
      timezone: SHANGHAI,
      cron: '0 8 * * *',
      status: 'missed',
      delivery: 'not-applicable',
      evidence: 'previous-lifetime-stopped-before-and-this-started-after-instant (enumerated under the current cron/timezone; definition changes during the gap are not knowable)',
      observedAt: '2026-11-25T00:24:00.000Z',
    });

    // Consecutive restart: the persisted record is present → not registered again.
    const persisted = new Map([[occurrenceKey('morning-report', NOV25_0800_CST), first.additions[0]]]);
    const second = reconcileStartup({ tasks: [dailyEight], evidence, records: persisted, now });
    expect(second.additions).toEqual([]);
    expect(second.interrupted).toEqual([]);
  });

  it('a run the previous lifetime actually completed keeps its recorded result (normal tick)', () => {
    const evidence = { previousStoppedAt: '2026-11-25T00:10:00Z', startedAt: '2026-11-25T00:24:00Z' };
    // 08:00 fired at 00:00Z, finished at 00:00:05Z, THEN the service stopped at 00:10Z —
    // the instant precedes the stop, so it is not inside the gap at all.
    const records = new Map([[occurrenceKey('morning-report', NOV25_0800_CST), record({})]]);
    const result = reconcileStartup({ tasks: [dailyEight], evidence, records, now });
    expect(result.additions).toEqual([]);
    expect(result.gaps).toEqual([]);
  });

  it('crash or kill (no clean stop): nothing is registered as missed or failed — the gap is reported', () => {
    const result = reconcileStartup({ tasks: [dailyEight], evidence: { startedAt: '2026-11-25T00:24:00Z' }, records: new Map(), now });
    expect(result.additions).toEqual([]);
    expect(result.gaps).toEqual([{
      taskId: 'morning-report',
      code: 'no-stop-evidence',
      detail: expect.any(String),
    }]);
    const lookup = classifyOccurrence({
      taskId: 'morning-report', scheduledFor: NOV25_0800_CST, task: dailyEight,
      records: new Map(), evidence: { startedAt: '2026-11-25T00:24:00Z' }, now,
    });
    expect(lookup.status).toBe('unknown');
    expect(lookup.evidence).toBe('no-record-and-no-clean-stop-boundary');
  });

  it('a run still marked executing when the previous lifetime ended is unknown, not left executing forever', () => {
    const stuck = record({ status: 'executing', delivery: 'not-applicable', observedAt: '2026-11-24T23:59:30Z', scheduledFor: '2026-11-24T00:00:00.000Z' });
    const result = reconcileStartup({
      tasks: [dailyEight],
      evidence: { previousStoppedAt: '2026-11-24T23:01:00Z', startedAt: '2026-11-25T00:24:00Z' },
      records: new Map([[occurrenceKey(stuck.taskId, stuck.scheduledFor), stuck]]),
      now,
    });
    expect(result.interrupted).toHaveLength(1);
    expect(result.interrupted[0]).toMatchObject({ status: 'unknown', evidence: 'previous-lifetime-ended-while-executing', scheduledFor: stuck.scheduledFor });
    // The 11-24 instant precedes the stop → not a gap occurrence either.
    expect(result.additions.map((a) => a.scheduledFor)).toEqual([NOV25_0800_CST]);

    const viaQuery = classifyOccurrence({
      taskId: 'morning-report', scheduledFor: stuck.scheduledFor, records: new Map([[occurrenceKey(stuck.taskId, stuck.scheduledFor), stuck]]),
      evidence: { startedAt: '2026-11-25T00:24:00Z' }, now,
    });
    expect(viaQuery.status).toBe('unknown');
  });

  it('a run executing in THIS lifetime is not rewritten', () => {
    const live = record({ status: 'executing', observedAt: '2026-11-25T00:24:30Z', scheduledFor: NOV26_0800_CST });
    const result = reconcileStartup({
      tasks: [dailyEight],
      evidence: { previousStoppedAt: '2026-11-24T23:01:00Z', startedAt: '2026-11-25T00:24:00Z' },
      records: new Map([[occurrenceKey(live.taskId, live.scheduledFor), live]]),
      now: at('2026-11-26T00:24:30Z'),
    });
    expect(result.interrupted).toEqual([]);
  });

  it('disabled tasks are not expected to fire: nothing is enumerated for them', () => {
    const result = reconcileStartup({
      tasks: [{ ...dailyEight, enabled: false }],
      evidence: { previousStoppedAt: '2026-11-24T23:01:00Z', startedAt: '2026-11-25T00:24:00Z' },
      records: new Map(), now,
    });
    expect(result).toEqual({ additions: [], interrupted: [], gaps: [] });
  });

  it('inconsistent lifecycle evidence (stop not before start) is a reported gap, not a missed run', () => {
    const result = reconcileStartup({
      tasks: [dailyEight],
      evidence: { previousStoppedAt: '2026-11-25T00:30:00Z', startedAt: '2026-11-25T00:24:00Z' },
      records: new Map(), now,
    });
    expect(result.additions).toEqual([]);
    expect(result.gaps.map((g) => g.code)).toEqual(['inconsistent-lifecycle-evidence']);
  });

  it('an invalid definition yields a gap and no records', () => {
    const result = reconcileStartup({
      tasks: [{ ...dailyEight, timezone: 'Mars/Olympus' }],
      evidence: { previousStoppedAt: '2026-11-24T23:01:00Z', startedAt: '2026-11-25T00:24:00Z' },
      records: new Map(), now,
    });
    expect(result.additions).toEqual([]);
    expect(result.gaps.map((g) => g.code)).toEqual(['invalid-definition']);
  });
});

describe('classifyOccurrence (read-only entry)', () => {
  const now = at('2026-11-25T00:24:00Z');
  const evidence = { previousStoppedAt: '2026-11-24T23:01:00Z', startedAt: '2026-11-25T00:24:00Z' };

  it('execution terminal state and final delivery are reported separately', () => {
    const failed = classifyOccurrence({
      taskId: 'morning-report', scheduledFor: NOV25_0800_CST, evidence, now,
      records: new Map([[occurrenceKey('morning-report', NOV25_0800_CST), record({ status: 'failed', delivery: 'unknown' })]]),
    });
    expect(failed.status).toBe('failed');
    expect(failed.delivery).toBe('unknown');
  });

  it('a not-yet-due instant is pending', () => {
    expect(classifyOccurrence({ taskId: 'morning-report', scheduledFor: NOV26_0800_CST, evidence, now, records: new Map() }).status).toBe('pending');
  });

  it('an instant inside the current lifetime with no record is unknown — not a success and not a definite failure', () => {
    const result = classifyOccurrence({
      taskId: 'morning-report', scheduledFor: NOV25_0800_CST, evidence: { startedAt: '2026-11-24T23:30:00Z' }, now, records: new Map(),
    });
    expect(result.status).toBe('unknown');
    expect(result.evidence).toBe('no-record-for-instant-inside-current-lifetime');
  });

  it('the stored identity wins over a later definition change (cron/timezone on the record are the historical ones)', () => {
    const stored = record({ cron: '30 7 * * 1', timezone: 'UTC', scheduledForLocal: '2026-11-24T07:30:00.000Z' });
    const result = classifyOccurrence({
      taskId: 'morning-report', scheduledFor: stored.scheduledFor, task: dailyEight, evidence, now,
      records: new Map([[occurrenceKey(stored.taskId, stored.scheduledFor), stored]]),
    });
    expect(result.cron).toBe('30 7 * * 1');
    expect(result.timezone).toBe('UTC');
    expect(result.scheduledForLocal).toBe('2026-11-24T07:30:00.000Z');
  });

  it('an unparseable instant is unknown, never thrown', () => {
    expect(classifyOccurrence({ taskId: 'x', scheduledFor: 'not-a-date', evidence, now, records: new Map() }).status).toBe('unknown');
  });
});
