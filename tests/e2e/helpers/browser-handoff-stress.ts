import { expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

type Event = { type: string; epoch?: number; waitMs?: number };

/** Exercises actual worker creation/reclamation without spending model tokens. */
export async function verifyRepeatedHandoffs(eventFile: string, run: (script: string) => Promise<string>): Promise<void> {
  const events = async (): Promise<Event[]> => (await readFile(eventFile, 'utf8')).split('\n')
    .filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as Event]; } catch { return []; } });
  await run("fill_input('#value', 'stress-seed')\n");
  const offset = (await events()).length;
  const started = performance.now();
  let previous = 'stress-seed';
  for (let index = 1; index <= 100; index++) {
    const next = `handoff-${index}`;
    const output = await run(`previous = js("document.querySelector('#value').value")\nassert previous == ${JSON.stringify(previous)}\nfill_input('#value', ${JSON.stringify(next)})\nassert js("document.querySelector('#value').value") == ${JSON.stringify(next)}\nprint('VERIFIED:${next}')\n`);
    expect(output).toContain(`VERIFIED:${next}`);
    previous = next;
  }
  let trace = (await events()).slice(offset);
  const grants = trace.filter(e => e.type === 'granted');
  expect(grants).toHaveLength(100);
  expect(new Set(grants.map(e => e.epoch)).size).toBe(100);
  const last = grants.at(-1);
  if (!last) { throw new Error('No browser handoffs recorded'); }
  for (let retry = 0; retry < 100 && !trace.some(e => e.type === 'reclaimed' && e.epoch === last.epoch); retry++) {
    await delay(50); trace = (await events()).slice(offset);
  }
  let previousReclaimed = -1;
  for (const grant of grants) {
    const at = (type: string): number => trace.findIndex(e => e.type === type && e.epoch === grant.epoch);
    expect(at('granted')).toBeGreaterThan(previousReclaimed);
    expect(at('execute')).toBeGreaterThan(at('granted'));
    expect(at('worker-exit')).toBeGreaterThan(at('execute'));
    expect(at('reclaimed')).toBeGreaterThan(at('worker-exit'));
    previousReclaimed = at('reclaimed');
  }
  expect(await run("print(js(\"document.querySelector('#value').value\"))\n")).toContain('handoff-100');
  const waits = grants.map(g => { expect(Number.isFinite(g.waitMs)).toBe(true); return Number(g.waitMs); }).sort((a, b) => a - b);
  console.info('BROWSER_REPEATED_HANDOFF', JSON.stringify({ handoffs: 100,
    allPriorStatesVerified: true, allWorkersReclaimedBeforeNextGrant: true,
    finalIndependentReadback: true, elapsedMs: performance.now() - started,
    grantWaitMs: { p50: waits[49], p95: waits[94], max: waits[99] } }));
}
