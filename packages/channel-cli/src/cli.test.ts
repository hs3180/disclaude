import { readFile } from 'node:fs/promises';
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

  it('requires an explicit REST address for a standalone invocation', async () => {
    const previous = process.env.DISCLAUDE_REST_IPC_BASE_URL;
    delete process.env.DISCLAUDE_REST_IPC_BASE_URL;
    try {
      const { code, writes } = await capture([
        'send_text', '--chat', 'oc_0123456789012345678901234567890123', '--text', 'hello',
      ]);
      expect(code).toBe(1);
      expect(JSON.parse(writes[0])).toMatchObject({
        ok: false,
        error: expect.stringContaining('--base-url'),
      });
    } finally {
      if (previous === undefined) { delete process.env.DISCLAUDE_REST_IPC_BASE_URL; }
      else { process.env.DISCLAUDE_REST_IPC_BASE_URL = previous; }
    }
  });

  it('rejects invalid REST addresses before loading channel tools', async () => {
    const { code, writes } = await capture([
      'send_text', '--chat', 'oc_0123456789012345678901234567890123', '--text', 'hello',
      '--base-url', 'localhost:19200/api',
    ]);
    expect(code).toBe(1);
    expect(JSON.parse(writes[0]).error).toContain('absolute http(s) URL');
  });

  it('routes `push` to push_to_agent and reports the canonical name', async () => {
    // Missing --message fails before any network call, which is enough to prove
    // the alias resolved: an unrouted command would fail on chat validation with
    // a different error, and `command` pins the JSON contract callers parse.
    const { code, writes } = await capture(['push', '--chat', 'oc_0123456789012345678901234567890123', '--base-url', 'http://127.0.0.1:19200']);
    expect(code).toBe(1);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toMatchObject({ ok: false, command: 'push_to_agent', error: 'Missing message content' });
  });

  it('still accepts the canonical push_to_agent spelling', async () => {
    const { code, writes } = await capture(['push_to_agent', '--chat', 'oc_0123456789012345678901234567890123', '--base-url', 'http://127.0.0.1:19200']);
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

  // Issue #4788, second root cause: unknown flags used to be stored and to eat
  // the following argv entry, so the run failed later on the argument that got
  // swallowed rather than on the flag that was wrong.
  describe('unknown flag rejection', () => {
    const CHAT = 'oc_0123456789012345678901234567890123';

    it('names the bad flag instead of failing on the argument it swallowed', async () => {
      const { code, writes } = await capture([
        'send_interactive', '--chat', CHAT,
        '--payload', '{"content":{}}',
        '--question', 'q',
        '--options', '[{"text":"a","value":"a"}]',
      ]);
      expect(code).toBe(1);
      expect(writes).toHaveLength(1);
      const result = JSON.parse(writes[0]);
      expect(result).toMatchObject({ ok: false, command: 'send_interactive', error: 'Unknown option: --payload' });
      // The old behaviour: --payload consumed its value and the run continued to
      // die on the input it no longer had.
      expect(result.error).not.toContain('Missing question content');
      expect(result.hint).toContain('--question');
    });

    it('rejects a flag that belongs to a different command', async () => {
      // --text is real, just not for send_file; a per-command whitelist catches
      // this where a global flag list would not.
      const { writes } = await capture(['send_file', '--chat', CHAT, '--file', './a.txt', '--text', 'hi']);
      expect(JSON.parse(writes[0])).toMatchObject({ ok: false, command: 'send_file', error: 'Unknown option: --text' });
    });

    it('lists every unknown flag, pluralised', async () => {
      const { writes } = await capture(['send_text', '--chat', CHAT, '--text', 'hi', '--foo', '1', '--bar', '2']);
      expect(JSON.parse(writes[0]).error).toBe('Unknown options: --foo, --bar');
    });

    it('reports a misspelled --chat as the unknown flag, not as a missing one', async () => {
      const { writes } = await capture(['send_text', '--caht', CHAT, '--text', 'hi']);
      const result = JSON.parse(writes[0]);
      expect(result.error).toBe('Unknown option: --caht');
      expect(result.error).not.toContain('Missing required option');
    });

    it('accepts every flag the command actually reads', async () => {
      // Nothing here is rejected, so the run gets past parsing and fails on the
      // unreachable REST endpoint instead — proving the whitelist is not too tight.
      const { writes } = await capture([
        'send_interactive', '--chat', CHAT, '--parent', 'om_x', '--base-url', 'http://127.0.0.1:1',
        '--api-token', 't', '--question', 'q', '--options', '[{"text":"a","value":"a"}]',
        '--action-prompts', '{"a":"p"}', '--title', 'T', '--context', 'C',
      ]);
      expect(JSON.parse(writes[0]).error).not.toContain('Unknown option');
    });

    it('keeps --help working alongside a command', async () => {
      const { writes } = await capture(['send_text', '--chat', CHAT, '--text', 'hi', '--help']);
      expect(JSON.parse(writes[0]).error ?? '').not.toContain('Unknown option');
    });

    it('whitelists every flag the README documents', async () => {
      // Guards the direction that actually breaks users: a flag the docs promise
      // but the whitelist omits is now a hard rejection, not a silent no-op. The
      // README table is the published contract, so read it rather than restate it.
      const readme = await readFile(new URL('../../../skills/channel/README.md', import.meta.url), 'utf8');
      const row = readme.split('\n').find((line) => line.startsWith('| `send_interactive`'));
      expect(row).toBeDefined();
      const documented = [...(row as string).matchAll(/`--([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
      expect(documented.length).toBeGreaterThan(0);
      // Serial, not Promise.all: run() shares a module-level `emitted` flag and
      // swaps the global process.stdout.write, so concurrent runs interleave
      // their output into one capture and starve the others.
      const rejected: string[] = [];
      for (const flag of documented) {
        const { writes } = await capture(['send_interactive', '--chat', CHAT, `--${flag}`, 'x']);
        if (String(JSON.parse(writes[0]).error).startsWith('Unknown option')) {rejected.push(`--${flag}`);}
      }
      expect(rejected).toEqual([]);
    });
  });
});
