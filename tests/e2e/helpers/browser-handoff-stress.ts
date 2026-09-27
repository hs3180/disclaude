import { expect } from 'vitest';
import { performance } from 'node:perf_hooks';

/** Exercises repeated page-state handoffs through the product IPC entry. */
export async function verifyRepeatedHandoffs(run: (script: string) => Promise<string>): Promise<void> {
  await run("fill_input('#value', 'stress-seed')\n");
  const started = performance.now();
  let previous = 'stress-seed';
  for (let index = 1; index <= 100; index++) {
    const next = `handoff-${index}`;
    const output = await run(`previous = js("document.querySelector('#value').value")\nassert previous == ${JSON.stringify(previous)}\nfill_input('#value', ${JSON.stringify(next)})\nassert js("document.querySelector('#value').value") == ${JSON.stringify(next)}\nprint('VERIFIED:${next}')\n`);
    expect(output).toContain(`VERIFIED:${next}`);
    previous = next;
  }
  expect(await run("print(js(\"document.querySelector('#value').value\"))\n")).toContain('handoff-100');
  console.info('BROWSER_REPEATED_HANDOFF', JSON.stringify({ handoffs: 100,
    allPriorStatesVerified: true, finalIndependentReadback: true, elapsedMs: performance.now() - started }));
}
