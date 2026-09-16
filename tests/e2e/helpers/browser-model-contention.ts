import { expect } from 'vitest';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ClaudeSDKProvider } from '../../../packages/core/src/sdk/providers/claude/provider.js';
import type { AgentMessage, StreamQueryResult } from '../../../packages/core/src/sdk/types.js';

type Event = { type: string; actor?: string; epoch?: number; ms: number };
export class ModelContentionCleanupError extends Error {}

/** Real model/tool requests; explicit scripts isolate arbitration from task planning. */
export async function verifyModelContention(root: string, env: NodeJS.ProcessEnv,
  model: string, eventFile: string, run: (script: string) => Promise<string>): Promise<void> {
  const events = async (): Promise<Event[]> => (await readFile(eventFile, 'utf8')).split('\n')
    .filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as Event]; } catch { return []; } });
  const offset = (await events()).length;
  const held = join(root, 'agent-a-holds-browser'), release = join(root, 'release-agent-a');
  const secondRan = join(root, 'agent-b-executed');
  const firstValue = 'draft-by-agent-a', finalValue = 'draft-reviewed-by-agent-b';
  const streams: Array<{ provider: ClaudeSDKProvider; query: StreamQueryResult; done: Promise<AgentMessage[]> }> = [];
  const waitFor = async (check: () => Promise<boolean>, description: string): Promise<void> => {
    const end = Date.now() + 90_000;
    while (Date.now() < end) { if (await check()) { return; } await delay(100); }
    throw new Error(`Model contention deadline: ${description}`);
  };
  function start(script: string): Promise<AgentMessage[]> {
    const provider = new ClaudeSDKProvider();
    const quoted = `'${script.replaceAll("'", "'\\''")}'`;
    async function* input() {
      yield { role: 'user' as const, content: `Run exactly this shell command with your Bash tool, then report its output:\nprintf '%s' ${quoted} | browser-use\nThis is a shared local draft acceptance fixture. Do not change the script, run extra tools, launch another browser, use direct CDP, delegate, or touch unrelated files.` };
    }
    const query = provider.queryStream(input(), { cwd: root, settingSources: [], env, model, tools: ['Bash'], allowedTools: ['Bash'] });
    const done = (async () => {
      const messages: AgentMessage[] = [];
      for await (const message of query.iterator) { messages.push(message); }
      return messages;
    })();
    // A failed agent must not create an unhandled rejection while the other is observed.
    void done.catch(() => {});
    streams.push({ provider, query, done });
    return done;
  }
  try {
    const first = start(`import os, time\nfill_input('#value', ${JSON.stringify(firstValue)})\nopen(${JSON.stringify(held)}, 'w').write('held')\nend = time.monotonic() + 100\nwhile not os.path.exists(${JSON.stringify(release)}):\n    assert time.monotonic() < end, 'release deadline exceeded'\n    time.sleep(0.1)\nprint('AGENT_A:' + js("document.querySelector('#value').value"))\n`);
    await waitFor(() => access(held).then(() => true, () => false), 'agent A holds the browser');
    const firstEvents = (await events()).slice(offset);
    const firstGrant = firstEvents.find(e => e.type === 'granted');
    if (!firstGrant?.actor || firstGrant.epoch === undefined) { throw new Error('Agent A did not acquire a recorded lease'); }
    const second = start(`previous = js("document.querySelector('#value').value")\nassert previous == ${JSON.stringify(firstValue)}\nopen(${JSON.stringify(secondRan)}, 'w').write('executed')\nfill_input('#value', ${JSON.stringify(finalValue)})\nprint('AGENT_B_PREVIOUS:' + previous)\n`);
    let secondActor: string | undefined;
    await waitFor(async () => {
      secondActor = (await events()).slice(offset).find(e => e.type === 'queued' && e.actor !== firstGrant.actor)?.actor;
      return Boolean(secondActor);
    }, 'agent B enters the coordinator queue');
    await expect(access(secondRan)).rejects.toThrow();
    expect((await events()).slice(offset).some(e => e.type === 'granted' && e.actor === secondActor)).toBe(false);
    await writeFile(release, 'release');
    const results = await Promise.race([
      Promise.all([first, second]),
      delay(90_000, undefined, { ref: false }).then(() => { throw new Error('Agents did not finish after handoff'); }),
    ]);
    for (const messages of results) {
      const result = messages.findLast(m => m.type === 'result');
      expect(result).toBeDefined();
      expect(result?.metadata?.terminatedReason).toBeUndefined();
      expect(messages.some(m => m.type === 'error')).toBe(false);
      expect(messages.some(m => m.type === 'tool_use')).toBe(true);
    }
    expect(results[0].some(m => m.type === 'tool_result' && m.content.includes(`AGENT_A:${firstValue}`))).toBe(true);
    expect(results[1].some(m => m.type === 'tool_result' && m.content.includes(`AGENT_B_PREVIOUS:${firstValue}`))).toBe(true);
    const trace = (await events()).slice(offset);
    const queued = trace.findIndex(e => e.type === 'queued' && e.actor === secondActor);
    const reclaimed = trace.findIndex(e => e.type === 'reclaimed' && e.epoch === firstGrant.epoch);
    const granted = trace.findIndex(e => e.type === 'granted' && e.actor === secondActor);
    expect(queued).toBeGreaterThanOrEqual(0);
    expect(reclaimed).toBeGreaterThan(queued);
    expect(granted).toBeGreaterThan(reclaimed);
    expect(await run("print(js(\"document.querySelector('#value').value\"))\n")).toContain(finalValue);
    console.info('BROWSER_MODEL_CONTENTION', JSON.stringify({ backend: 'claude', agents: 2,
      queuedWhileHeld: true, noExecutionBeforeRelease: true, reclamationBeforeGrant: true,
      priorDraftVerified: true, independentReadback: true,
      queueWaitMs: trace[granted].ms - trace[queued].ms }));
  } finally {
    // Unblock the owned browser script even when an observation/assertion fails.
    const failures: unknown[] = [];
    try { await writeFile(release, 'release'); } catch (error) { failures.push(error); }
    for (const { query } of streams) {
      try { query.handle.cancel(); } catch (error) { failures.push(error); }
      try { query.handle.close(); } catch (error) { failures.push(error); }
    }
    const settled = await Promise.race([Promise.allSettled(streams.map(s => s.done)).then(() => true), delay(10_000, false, { ref: false })]);
    for (const { provider } of streams) {
      try { provider.dispose(); } catch (error) { failures.push(error); }
    }
    if (!settled || failures.length) { throw new ModelContentionCleanupError(`Model cleanup unconfirmed; inspect owned processes for ${root}`); }
  }
}
