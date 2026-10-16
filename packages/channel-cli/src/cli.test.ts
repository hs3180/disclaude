import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
  it.each(['send_text', 'send_interactive'])('rejects synthetic reply IDs before any %s request', async command => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    try {
      const flags = command === 'send_text' ? ['--text', 'probe'] : ['--question', 'probe', '--options', '[{"text":"ok","value":"ok"}]'];
      const { code, writes } = await capture([command, '--chat', 'oc_0123456789012345678901234567890123', '--base-url', 'http://127.0.0.1:19200', '--parent', 'sched-owned-task', ...flags]);
      expect(code).toBe(1);
      expect(JSON.parse(writes[0]).error).toContain('Internal tracking IDs');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {fetchMock.mockRestore();}
  });

  it('does not label an upstream rejection as a network outage', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(url => Promise.resolve(String(url).endsWith('/api/ping') ? new Response(JSON.stringify({ ok: true, pong: true })) : new Response(JSON.stringify({ ok: false, message: 'upstream HTTP 400: 99991663 chat id is invalid' }), { status: 400 })));
    try {
      const { code, writes } = await capture(['send_text', '--chat', 'oc_0123456789012345678901234567890123', '--text', 'probe', '--base-url', 'http://127.0.0.1:19200']);
      expect(code).toBe(1);
      const result = JSON.parse(writes[0]);
      expect(result.error).toContain('99991663 chat id is invalid');
      expect(result.hint).toBeUndefined();
    } finally {fetchMock.mockRestore();}
  });
  it('exposes the packaged command surface in help', () => {
    expect(HELP).toContain('send_interactive');
    expect(HELP).toContain('disclaude channel');
    for (const flag of ['--question-file', '--options', '--action-prompts', '--thread-root', '--idempotency-key', '--workflow-file']) {
      expect(HELP).toContain(flag);
    }
    expect(HELP).toContain('Private values enter only through that card');
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
    const previous = process.env.DISCLAUDE_API_BASE_URL;
    delete process.env.DISCLAUDE_API_BASE_URL;
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
      if (previous === undefined) { delete process.env.DISCLAUDE_API_BASE_URL; }
      else { process.env.DISCLAUDE_API_BASE_URL = previous; }
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
        '--thread-root', 'om_topic_root',
        '--idempotency-key', 'codex-followup:om_x',
        '--api-token', 't', '--question', 'q', '--options', '[{"text":"a","value":"a"}]',
        '--action-prompts', '{"a":"p"}', '--title', 'T', '--context', 'C',
      ]);
      expect(JSON.parse(writes[0]).error).not.toContain('Unknown option');
    });

    it('requires action prompts when an idempotency key is requested', async () => {
      const { writes } = await capture([
        'send_interactive', '--chat', CHAT, '--question', 'q', '--options', '[{"text":"a","value":"a"}]',
        '--idempotency-key', 'codex-followup:om_x',
      ]);
      expect(JSON.parse(writes[0]).error).toContain('--action-prompts');
    });

    it.each(['send_text', 'send_file', 'send_card', 'push', 'push_to_agent', 'send_interactive', 'request_private_input'])('short-circuits %s help before chat, unknown-flag and runtime validation', async command => {
      const fetch = vi.spyOn(globalThis, 'fetch');
      try {
        const { code, writes } = await capture([command, '--unknown', '--help']);
        expect(code).toBe(0);
        expect(writes.join('')).toContain(`Usage: disclaude channel ${command === 'push_to_agent' ? 'push' : command}`);
        expect(writes.join('')).toContain('--dry-run');
        expect(fetch).not.toHaveBeenCalled();
      } finally { fetch.mockRestore(); }
    });

    it('whitelists exactly the flags send_interactive reads', async () => {
      // Guards both directions without a docs file: a flag callers rely on that
      // the whitelist omits is a hard rejection, not a silent no-op, and the
      // whitelist cannot grow silently either. The CLI restates its accepted
      // set in the failure hint, so pin that list exactly.
      const { writes } = await capture(['send_interactive', '--chat', CHAT, '--not-a-flag', 'x']);
      const result = JSON.parse(writes[0]);
      expect(result.error).toBe('Unknown option: --not-a-flag');
      const accepted = [...String(result.hint ?? '').matchAll(/--([a-z][a-z0-9-]*)/g)].map(
        (m) => m[1]
      );
      expect(accepted).toEqual([
        'action-prompts',
        'action-prompts-file',
        'api-token',
        'base-url',
        'chat',
        'context',
        'dry-run',
        'idempotency-key',
        'options',
        'options-file',
        'parent',
        'question',
        'question-file',
        'thread-root',
        'title',
      ]);
    });
  });
});

describe('local channel input preview', () => {
  const chat = 'oc_0123456789012345678901234567890123';
  const base = ['send_interactive', '--dry-run', '--chat', chat, '--question', '继续？'];
  it('previews decoded single-escape JSON without REST configuration, network or credential disclosure', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected fixture network'));
    try {
      const { code, writes } = await capture([...base, '--api-token', 'owned-preview-only-token',
        '--options', String.raw`[{"text":"\u4fee\u6b63","value":"fix"}]`, '--action-prompts', '{"fix":"按选择修正"}']);
      expect(code).toBe(0);
      const result = JSON.parse(writes[0]);
      expect(result).toMatchObject({ dryRun: true, payload: { options: [{ text: '修正', value: 'fix' }] },
        decodedPreview: { options: [{ text: '修正' }], actionPrompts: { fix: { text: '按选择修正' } } } });
      expect(writes.join('')).not.toContain('owned-preview-only-token');
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
  it('reads raw UTF-8 options and prompts from files, preserving topic and idempotency routing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'channel-json-input-'));
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected fixture network'));
    try {
      const options = join(root, 'options.json'); const prompts = join(root, 'prompts.json');
      writeFileSync(options, `\uFEFF${JSON.stringify([{ text: '修正两处（报告+表格）', value: 'fix', type: 'primary' }])}`);
      writeFileSync(prompts, JSON.stringify({ fix: '用户选择修正两处，请继续原任务' }));
      const { code, writes } = await capture([...base, '--options-file', options, '--action-prompts-file', prompts,
        '--parent', 'om_source', '--thread-root', 'om_topic', '--idempotency-key', 'followup:om_source']);
      expect(code).toBe(0);
      expect(JSON.parse(writes[0]).payload).toMatchObject({ parentMessageId: 'om_source', threadRootId: 'om_topic',
        idempotencyKey: 'followup:om_source', options: [{ text: '修正两处（报告+表格）' }],
        actionPrompts: { fix: '用户选择修正两处，请继续原任务' } });
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); rmSync(root, { recursive: true }); }
  });
  it.each(['options', 'action-prompts'])('rejects dense double-escaped Unicode in %s before delivery', async field => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected fixture network'));
    try {
      const escaped = String.raw`\u4fee\u6b63\u4e24\u5904`;
      const flags = field === 'options'
        ? ['--options', JSON.stringify([{ text: escaped, value: 'fix' }])]
        : ['--options', '[{"text":"修正","value":"fix"}]', '--action-prompts', JSON.stringify({ fix: escaped })];
      const { code, writes } = await capture([...base, ...flags]);
      expect(code).toBe(1);
      expect(JSON.parse(writes[0]).error).toContain('likely double-escaped JSON');
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
  it.each([
    ['--options', '[', 'Invalid --options JSON'],
    ['--options', '[{"text":"A","value":"a"}]', '--idempotency-key', 'owned', 'requires --action-prompts'],
    ['--options', '[{"text":"A","value":"a"}]', '--action-prompts', '{}', 'map every option value'],
    ['--options', '[{"text":"A","value":"a"}]', '--options-file', '/owned/missing', 'Use only one'],
    ['--options-file', '-', '--action-prompts-file', '-', 'stdin can supply only one'],
  ])('validates dry-run without probing or sending (%s)', async (...row) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected fixture network'));
    try {
      const expected = row.at(-1)!;
      const { code, writes } = await capture([...base, ...row.slice(0, -1)]);
      expect(code).toBe(1);
      expect(JSON.parse(writes[0]).error).toContain(expected);
      expect(fetch).not.toHaveBeenCalled();
      if (expected.startsWith('Invalid')) { expect(JSON.parse(writes[0]).error).toContain('UTF-8 bytes'); }
    } finally { fetch.mockRestore(); }
  });
  it('preserves a literal Unicode example when it is a small part of readable text', async () => {
    const { code, writes } = await capture([...base, '--options', JSON.stringify([
      { text: String.raw`Show the literal escape \u4f60 in the explanation`, value: 'explain' },
    ])]);
    expect(code).toBe(0);
    expect(JSON.parse(writes[0]).decodedPreview.options[0].text).toContain(String.raw`\u4f60`);
  });
  it('never consumes --dry-run as a missing value for the preceding option', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected fixture network'));
    try {
      const { code, writes } = await capture(['send_text', '--text', '--dry-run', '--chat', chat]);
      expect(code).toBe(1);
      expect(JSON.parse(writes[0]).error).toBe('Missing value for --text');
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
  it.each([
    ['send_text', '--text', 'owned text'], ['push', '--message', 'owned instruction'],
    ['request_private_input', '--actor', 'ou_owned', '--source', 'om_owned', '--workflow', '{"command":"owned","title":"Owned","description":"Owned metadata"}'],
  ])('does not execute a dry-run %s', async (...flags) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected fixture network'));
    try {
      const { code, writes } = await capture([...flags, '--chat', chat, '--dry-run']);
      expect(code).toBe(0);
      expect(JSON.parse(writes[0])).toMatchObject({ dryRun: true });
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
});
