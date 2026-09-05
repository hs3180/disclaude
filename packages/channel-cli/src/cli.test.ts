import { describe, expect, it } from 'vitest';
import { HELP, run } from './cli.js';

/** Run the CLI with stdout captured, returning the emitted lines and exit code. */
async function capture(argv: string[]): Promise<{ code: number; writes: string[] }> {
  const writes: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    return { code: await run(argv), writes };
  } finally {
    process.stdout.write = original;
  }
}

describe('@disclaude/channel-cli', () => {
  it('exposes the packaged command surface in help', () => {
    expect(HELP).toContain('send_interactive');
    expect(HELP).toContain('disclaude channel');
  });

  it('advertises `push`, not the internal push_to_agent spelling', () => {
    expect(HELP).toContain('push ');
    expect(HELP).not.toContain('push_to_agent');
  });

  it('documents exactly one invocation form', () => {
    // The `disclaude-channel` bin was removed so `disclaude channel` is the only
    // entry point; help must not resurrect the second spelling.
    expect(HELP).not.toContain('disclaude-channel');
  });

  it('keeps argument failures to one JSON result', async () => {
    const { code, writes } = await capture(['send_text']);
    expect(code).toBe(1);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toMatchObject({ ok: false, command: 'send_text' });
  });

  it('routes `push` to push_to_agent and reports the canonical name', async () => {
    // Missing --message fails before any network call, which is enough to prove
    // the alias resolved: an unrouted command would fail on chat validation with
    // a different error, and `command` pins the JSON contract callers parse.
    const { code, writes } = await capture(['push', '--chat', 'oc_0123456789012345678901234567890123']);
    expect(code).toBe(1);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toMatchObject({ ok: false, command: 'push_to_agent', error: 'Missing message content' });
  });

  it('still accepts the canonical push_to_agent spelling', async () => {
    const { code, writes } = await capture(['push_to_agent', '--chat', 'oc_0123456789012345678901234567890123']);
    expect(code).toBe(1);
    expect(JSON.parse(writes[0])).toMatchObject({ ok: false, command: 'push_to_agent' });
  });

  it('reports the spelling the caller typed for unknown commands', async () => {
    const writes: string[] = [];
    const errs: string[] = [];
    const originalOut = process.stdout.write;
    const originalErr = process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { errs.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      expect(await run(['pushx'])).toBe(1);
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }
    // Not normalised to push_to_agent — the user typed `pushx`.
    expect(errs.join('')).toContain('Unknown command: pushx');
  });
});
