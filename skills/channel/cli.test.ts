// Smoke test for the channel Skill CLI (skills/channel/cli.mjs).
//
// Issue #4459 part 3 (PR #4467). This is a NO-IPC stub smoke test: it spawns
// the real CLI as a child process and locks the output contract the agent
// depends on — WITHOUT a running PrimaryNode, Feishu credentials, or network.
//
// Scope notes (why this is safe to add):
//  - `npm run lint` only targets the packages source dirs, so this file is NOT
//    linted (no risk to the lint gate).
//  - root tsconfig has an empty `files` list + package references only, so
//    skills/ is NOT type-checked; this file is transpiled by vitest/esbuild at
//    run time (no risk to the type-check gate).
//  - vitest.config.ts `include` covers skills test files, so this DOES run.
//  - coverage `include` covers only src and packages ts files, so skills/ is
//    NOT measured — this test cannot drag the 70 percent coverage thresholds.
//
// What this locks (and why each matters):
//  1. Output contract — every send_text failure emits EXACTLY ONE JSON object
//     on stdout and exits 1. The agent parses stdout as a single JSON; any
//     extra line (a second JSON, a stray log) would break it. (#4459 §2.2)
//  2. The pino->stderr redirect hack (cli.mjs withStdoutToStderr). send_text
//     logs `logger.info(..., 'send_text called')` via pino, whose default
//     destination is process.stdout. The CLI temporarily reroutes
//     process.stdout.write -> process.stderr for the import + IPC call so the
//     result JSON is the only thing on stdout. We assert the pino line lands on
//     stderr, NOT stdout. Exercised on the real import path: with no
//     PrimaryNode, send_text fails FAST (isIpcAvailable -> existsSync false)
//     but only AFTER the logger.info write, so the redirect is provably active.
//     NODE_ENV=test makes pino synchronous (no pino-pretty worker), so the
//     redirect is deterministic with no flush race.
//  3. help / unknown-command surface and exit codes.
//
// Parts 4–7 of #4459 added the `send_file`, `send_card`, `push_to_agent`, and
// `send_interactive` tests below (same harness, same contract). All five
// channel tools are now CLI subcommands. The send_card preprocessing / send
// path needs a built PrimaryNode + creds and is covered by the channel-mcp
// handler tests, not here.
//
// Part 11 of #4459 (REST re-land of rejected #4521) added the chatId-format
// pre-check tests: every subcommand rejects an ill-formed --chat before
// importing the channel implementation, mirroring the former entry handlers'
// getChatIdValidationError pre-check (#1641). (The placeholder chat id below
// is format-valid on purpose — `oc_test` alone is now rejected by the format
// gate.)
//
// Parts 3–7 + 11 of #4459 — does not auto-close the parent issue.

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, 'cli.mjs');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `node skills/channel/cli.mjs <args>` and collect {code, stdout, stderr}.
 * stdin is a pipe closed immediately so any readStdinSync-on-pipe path returns
 * '' (EOF) instead of blocking. `extraEnv` merges into the child env (used to
 * force deterministic pino behavior for the redirect test).
 */
function runCli(
  args: string[],
  extraEnv: Record<string, string> = {},
  timeoutMs = 20000
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(new Error(`cli timed out after ${timeoutMs}ms (args: ${args.join(' ')})`));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    // Signal EOF on stdin so a readStdinSync-on-pipe path cannot block.
    child.stdin.end();
  });
}

/** Lines of `text` with content (drops empties), used to assert "exactly one". */
function nonEmptyLines(text: string): string[] {
  return text.split('\n').filter((l) => l.length > 0);
}

/** Parse the single expected JSON object on stdout; fail loudly if >1 line. */
function parseSingleJson(stdout: string): Record<string, unknown> {
  const lines = nonEmptyLines(stdout);
  expect(lines.length, `stdout must be exactly one JSON line, got ${lines.length}`).toBe(1);
  return JSON.parse(lines[0]);
}

describe('channel Skill CLI — output contract (no IPC)', () => {
  describe('send_text validation failures — exactly one JSON, exit 1', () => {
    it('missing --chat', async () => {
      const r = await runCli(['send_text', '--text', 'hi'], { FEISHU_CLI_CHAT_ID: '' });
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_text' });
      expect(String(obj.error)).toMatch(/--chat/i);
    });

    it('uses FEISHU_CLI_CHAT_ID when --chat is omitted', async () => {
      const r = await runCli(['send_text', '--text', ''], {
        FEISHU_CLI_CHAT_ID: 'oc_test0123456789012345678901234567890',
      });
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_text' });
      expect(String(obj.error)).toMatch(/text/i);
      expect(String(obj.error)).not.toMatch(/--chat/i);
    });

    it('gives explicit --chat priority over FEISHU_CLI_CHAT_ID', async () => {
      const r = await runCli(
        ['send_text', '--chat', 'oc_test0123456789012345678901234567890', '--text', ''],
        { FEISHU_CLI_CHAT_ID: 'not-a-chat-id' }
      );
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_text' });
      expect(String(obj.error)).toMatch(/text/i);
      expect(String(obj.error)).not.toMatch(/chatid format/i);
    });

    it('missing text content', async () => {
      const r = await runCli(['send_text', '--chat', 'oc_test0123456789012345678901234567890']);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_text' });
      expect(String(obj.error)).toMatch(/text/i);
    });

    it('invalid --mentions JSON', async () => {
      const r = await runCli([
        'send_text',
        '--chat',
        'oc_test0123456789012345678901234567890',
        '--text',
        'hi',
        '--mentions',
        'not-json',
      ]);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_text' });
      expect(String(obj.error)).toMatch(/mentions/i);
    });

    it('unreadable --text-file', async () => {
      const r = await runCli([
        'send_text',
        '--chat',
        'oc_test0123456789012345678901234567890',
        '--text-file',
        '/no/such/path/xyz',
      ]);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_text' });
      expect(String(obj.error)).toMatch(/text-file/i);
    });
  });

  describe('chatId format pre-check — every subcommand, pre-import (part 11)', () => {
    // Issue #4459 part 11 (REST re-land of rejected #4521): parts 3/4/6/7
    // checked --chat for presence only and let the transport layer reject
    // ill-formed ids. Every MCP entry handler runs a getChatIdValidationError
    // pre-check (#1641); on the REST CLI the server only validates chatId as
    // a non-empty string, so the pre-import twin gate is the only place the
    // format rules run. All failures below are detected BEFORE importing
    // channel implementation, so they need no build / PrimaryNode / creds.
    const BAD_CHAT = 'not-a-chat-id';

    it.each(['send_text', 'send_interactive', 'send_file', 'push_to_agent'] as const)(
      '%s: ill-formed --chat fails fast with the format error, exactly one JSON',
      async (command) => {
        const args = [command, '--chat', BAD_CHAT];
        // Minimal valid-ish payload per command so the ONLY failure is the
        // chatId format check (chatId is validated first anyway, but keep the
        // payloads non-empty to prove the point).
        if (command === 'send_text') args.push('--text', 'hi');
        if (command === 'send_interactive')
          args.push('--question', 'q', '--options', '[{"text":"a","value":"a"}]');
        if (command === 'send_file') args.push('--file', '/tmp/x.txt');
        if (command === 'push_to_agent') args.push('--message', 'hi');
        const r = await runCli(args);
        expect(r.code).toBe(1);
        const obj = parseSingleJson(r.stdout);
        expect(obj).toMatchObject({ ok: false, command });
        expect(String(obj.error)).toMatch(/invalid chatid format/i);
        expect(String(obj.error)).toMatch(/oc_|ou_|cli-/);
      }
    );

    it('send_card: ill-formed --chat is rejected pre-import too (twin covers all 5)', async () => {
      // Unlike part 5 (which validated chatId only post-import via the
      // exported helper), the pre-import twin now gates send_card as well —
      // a format failure there never loads the channel implementation.
      // The valid card makes the chatId the ONLY failure.
      const VALID_CARD = JSON.stringify({
        config: { wide_screen_mode: true },
        header: { title: { content: 't', tag: 'plain_text' }, template: 'blue' },
        elements: [],
      });
      const r = await runCli(['send_card', '--chat', BAD_CHAT, '--card', VALID_CARD]);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_card' });
      expect(String(obj.error)).toMatch(/invalid chatid format/i);
    });

    it('send_text: too-short oc_ id (right prefix, under minLength) is rejected', async () => {
      const r = await runCli(['send_text', '--chat', 'oc_x', '--text', 'hi']);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_text' });
      expect(String(obj.error)).toMatch(/invalid chatid format/i);
    });

    it('send_text: leading whitespace is rejected (mirrors isValidChatId trim guard)', async () => {
      const r = await runCli([
        'send_text',
        '--chat',
        '  oc_0123456789012345678901234567890ab',
        '--text',
        'hi',
      ]);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_text' });
      expect(String(obj.error)).toMatch(/invalid chatid format/i);
    });

    it('send_text: cli- session id (min length 5) passes the format gate', async () => {
      // Format-valid ids reach the NEXT failure (missing text content here),
      // proving the format gate accepted the cli- prefix — this locks the
      // pre-import twin against the exported validator's pattern table.
      const r = await runCli(['send_text', '--chat', 'cli-abc123']);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_text' });
      expect(String(obj.error)).toMatch(/text/i); // NOT a chatId error
    });

    it('twin error text carries the pattern labels (byte-identical to the exported helper)', async () => {
      // ff0f7bad nit, REST re-land: the twin's format list must include each
      // pattern's label (e.g. "Feishu group chat"), not bare prefixes — the
      // agent-facing message stays identical whichever path rejects the id.
      const r = await runCli(['send_text', '--chat', BAD_CHAT, '--text', 'hi']);
      const obj = parseSingleJson(r.stdout);
      expect(String(obj.error)).toMatch(/- `oc_...` \(Feishu group chat\)/);
      expect(String(obj.error)).toMatch(/- `ou_...` \(Feishu user \(p2p chat\)\)/);
      expect(String(obj.error)).toMatch(/- `cli-...` \(CLI session\)/);
    });
  });

  describe('send_card validation failures — exactly one JSON, exit 1 (part 5)', () => {
    // These all fail in the cheap, pre-import validation path, so they need no
    // PrimaryNode, no creds, and no built channel implementation — they lock the
    // send_card command surface and output contract the agent depends on.
    it('missing --chat', async () => {
      const r = await runCli(['send_card', '--card', '{"elements":[]}']);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_card' });
      expect(String(obj.error)).toMatch(/--chat/i);
    });

    it('missing card content (no --card / --card-file / stdin)', async () => {
      // stdin is a closed pipe (EOF) in runCli, so the stdin fallback yields ''
      // and the CLI reports missing card content rather than blocking.
      const r = await runCli(['send_card', '--chat', 'oc_test0123456789012345678901234567890']);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_card' });
      expect(String(obj.error)).toMatch(/card content|missing/i);
    });

    it('invalid --card JSON', async () => {
      const r = await runCli([
        'send_card',
        '--chat',
        'oc_test0123456789012345678901234567890',
        '--card',
        'not-json',
      ]);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_card' });
      expect(String(obj.error)).toMatch(/invalid card json/i);
    });

    it('card is not an object (array rejected — mirrors handler guard)', async () => {
      const r = await runCli([
        'send_card',
        '--chat',
        'oc_test0123456789012345678901234567890',
        '--card',
        '[1,2,3]',
      ]);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_card' });
      expect(String(obj.error)).toMatch(/must be an object/i);
    });

    // Post-import validation path: an object card that fails isValidFeishuCard
    // (missing config/header). This imports the channel implementation (so it needs
    // `npm run build`, like the redirect test below) but never reaches a pino
    // write — it locks the one-JSON teardown contract (cli.mjs exitWithCode /
    // resultEmitted): the failure JSON is the ONLY object on stdout even though
    // process.exit trips pino's sonic-boom "not ready" flush.
    it('invalid card structure (object missing config/header) — exactly one JSON', async () => {
      const r = await runCli([
        'send_card',
        '--chat',
        'oc_test0123456789012345678901234567890',
        '--card',
        '{"elements":[]}',
      ]);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout); // asserts stdout is exactly ONE JSON line
      expect(obj).toMatchObject({ ok: false, command: 'send_card' });
      expect(String(obj.error)).toMatch(/invalid card structure/i);
    });
  });

  describe('send_interactive validation failures — exactly one JSON, exit 1', () => {
    // Issue #4459 part 7: send_interactive mirrors the send_text validation
    // pattern. All failures are detected BEFORE importing the channel implementation
    // (cheap, deterministic, no IPC) and emit exactly one JSON object on stdout.
    it('missing --chat', async () => {
      const r = await runCli([
        'send_interactive',
        '--question',
        'q',
        '--options',
        '[{"text":"a","value":"a"}]',
      ]);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_interactive' });
      expect(String(obj.error)).toMatch(/--chat/i);
    });

    it('missing question content', async () => {
      const r = await runCli([
        'send_interactive',
        '--chat',
        'oc_test0123456789012345678901234567890',
        '--options',
        '[{"text":"a","value":"a"}]',
      ]);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_interactive' });
      expect(String(obj.error)).toMatch(/question/i);
    });

    it('missing --options', async () => {
      const r = await runCli([
        'send_interactive',
        '--chat',
        'oc_test0123456789012345678901234567890',
        '--question',
        'q',
      ]);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_interactive' });
      expect(String(obj.error)).toMatch(/--options/i);
    });

    it('invalid --options JSON', async () => {
      const r = await runCli([
        'send_interactive',
        '--chat',
        'oc_test0123456789012345678901234567890',
        '--question',
        'q',
        '--options',
        'not-json',
      ]);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_interactive' });
      expect(String(obj.error)).toMatch(/--options JSON/i);
    });

    it('invalid option structure (missing value)', async () => {
      const r = await runCli([
        'send_interactive',
        '--chat',
        'oc_test0123456789012345678901234567890',
        '--question',
        'q',
        '--options',
        '[{"text":"a"}]',
      ]);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_interactive' });
      expect(String(obj.error)).toMatch(/options\[0\]\.value/i);
    });

    it('invalid --action-prompts (array, not object)', async () => {
      const r = await runCli([
        'send_interactive',
        '--chat',
        'oc_test0123456789012345678901234567890',
        '--question',
        'q',
        '--options',
        '[{"text":"a","value":"a"}]',
        '--action-prompts',
        '["x"]',
      ]);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_interactive' });
      expect(String(obj.error)).toMatch(/action-prompts/i);
    });
  });

  describe('pino->stderr redirect hack (cli.mjs withStdoutToStderr)', () => {
    // Valid args pass validation and reach the real import + send_text call.
    // With no PrimaryNode, send_text fails FAST (isIpcAvailable -> existsSync
    // false) but only AFTER logger.info('send_text called') — a pino write to
    // stdout that the redirect must reroute to stderr. NODE_ENV=test makes pino
    // synchronous (no pino-pretty transport), so the redirect is deterministic
    // (no worker-flush race). LOG_LEVEL=debug guarantees the info line emits
    // regardless of any inherited LOG_LEVEL.
    it('keeps the pino "send_text called" line off stdout (routed to stderr)', async () => {
      const r = await runCli(
        ['send_text', '--chat', 'oc_test0123456789012345678901234567890', '--text', 'hi'],
        { NODE_ENV: 'test', LOG_LEVEL: 'debug' }
      );
      expect(r.code).toBe(1);
      // stdout is still exactly one JSON object — the contract holds even on
      // the import/send_text path where pino is active.
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_text' });
      // The pino line must NOT be on stdout…
      expect(r.stdout).not.toContain('send_text called');
      // …and SHOULD be on stderr (proves the redirect routed it there).
      expect(r.stderr).toContain('send_text called');
    }, 30000);

    // Issue #4459 part 7: same redirect guarantee for send_interactive. The
    // first-party send_interactive_message logs 'send_interactive_message
    // called' at the top of the fn (interactive-message.ts), before the
    // isIpcAvailable check — so with no PrimaryNode it still emits the pino
    // line and then fails fast. The CLI must keep that line off stdout.
    it('keeps the pino "send_interactive_message called" line off stdout (routed to stderr)', async () => {
      const r = await runCli(
        [
          'send_interactive',
          '--chat',
          'oc_test0123456789012345678901234567890',
          '--question',
          'Pick one',
          '--options',
          '[{"text":"A","value":"a","type":"primary"}]',
        ],
        { NODE_ENV: 'test', LOG_LEVEL: 'debug' }
      );
      expect(r.code).toBe(1);
      // stdout is still exactly one JSON object — the contract holds even on
      // the import/send_interactive path where pino is active.
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_interactive' });
      // The pino line must NOT be on stdout…
      expect(r.stdout).not.toContain('send_interactive_message called');
      // …and SHOULD be on stderr (proves the redirect routed it there).
      expect(r.stderr).toContain('send_interactive_message called');
    }, 30000);
  });

  describe('send_file validation failures — exactly one JSON, exit 1', () => {
    it('missing --chat', async () => {
      const r = await runCli(['send_file', '--file', '/tmp/x.txt']);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_file' });
      expect(String(obj.error)).toMatch(/--chat/i);
    });

    it('missing --file', async () => {
      const r = await runCli(['send_file', '--chat', 'oc_test0123456789012345678901234567890']);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_file' });
      expect(String(obj.error)).toMatch(/--file/i);
    });
  });

  describe('send_file pino->stderr redirect (cli.mjs withStdoutToStderr)', () => {
    // Valid args pass validation and reach the real import + send_file call.
    // Without a PrimaryNode / credentials the call fails, but not before a pino
    // write: with no creds send_file logs `logger.warn(..., 'File send skipped
    // (platform not configured)')`; with creds it logs
    // `logger.debug(..., 'send_file called')` then fails on fs.stat/IPC. Either
    // way a pino line must land on stderr, never stdout.
    it('keeps the pino send_file log line off stdout (routed to stderr)', async () => {
      const r = await runCli(
        [
          'send_file',
          '--chat',
          'oc_test0123456789012345678901234567890',
          '--file',
          '/no/such/file/xyz',
        ],
        { NODE_ENV: 'test', LOG_LEVEL: 'debug' }
      );
      expect(r.code).toBe(1);
      // stdout is still exactly one JSON object — the contract holds even on
      // the import/send_file path where pino is active.
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_file' });
      // The pino line must NOT be on stdout…
      expect(r.stdout).not.toMatch(/send_file called|File send skipped/);
      // …and SHOULD be on stderr (proves the redirect routed it there).
      expect(r.stderr).toMatch(/send_file called|File send skipped/);
    }, 30000);
  });

  describe('push_to_agent validation failures — exactly one JSON, exit 1 (part 6)', () => {
    it('missing --chat', async () => {
      const r = await runCli(['push_to_agent', '--message', 'hi']);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'push_to_agent' });
      expect(String(obj.error)).toMatch(/--chat/i);
    });

    it('missing message content', async () => {
      const r = await runCli(['push_to_agent', '--chat', 'oc_test0123456789012345678901234567890']);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'push_to_agent' });
      expect(String(obj.error)).toMatch(/message/i);
    });

    it('unreadable --message-file', async () => {
      const r = await runCli([
        'push_to_agent',
        '--chat',
        'oc_test0123456789012345678901234567890',
        '--message-file',
        '/no/such/path/xyz',
      ]);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'push_to_agent' });
      expect(String(obj.error)).toMatch(/message-file/i);
    });
  });

  describe('push_to_agent pino->stderr redirect (part 6)', () => {
    // Same rationale as the send_text redirect test above: valid args pass
    // validation and reach the real import + push_to_agent call, which logs
    // logger.info({ ... }, 'push_to_agent called') via pino — a write to stdout
    // that the redirect must reroute to stderr. NODE_ENV=test makes pino
    // synchronous (no pino-pretty transport); LOG_LEVEL=debug guarantees the
    // info line emits regardless of inherited LOG_LEVEL. Requires `npm run build`
    // so the import resolves to the real module (CI runs build before vitest).
    //
    // Exit code is intentionally NOT asserted: push_to_agent is non-blocking
    // (issue #631) — against a live PrimaryNode it returns success (exit 0) by
    // enqueuing the instruction, while without a PrimaryNode it fails fast
    // (exit 1). Either way the pino line must be off stdout, which is what this
    // test locks. The chat id is format-valid but not a real chat, so no
    // real delivery occurs.
    it('keeps the pino "push_to_agent called" line off stdout (routed to stderr)', async () => {
      const r = await runCli(
        ['push_to_agent', '--chat', 'oc_test0123456789012345678901234567890', '--message', 'hi'],
        { NODE_ENV: 'test', LOG_LEVEL: 'debug' }
      );
      // stdout is still exactly one JSON object — the contract holds even on
      // the import/push_to_agent path where pino is active.
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ command: 'push_to_agent' });
      // The pino line must NOT be on stdout…
      expect(r.stdout).not.toContain('push_to_agent called');
      // …and SHOULD be on stderr (proves the redirect routed it there).
      expect(r.stderr).toContain('push_to_agent called');
    }, 30000);
  });

  describe('help / unknown-command surface', () => {
    it('no args -> help text, exit 0', async () => {
      const r = await runCli([]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('channel Skill');
      expect(r.stdout).toContain('send_text');
      expect(r.stdout).toContain('send_file');
      expect(r.stdout).toContain('push_to_agent');
      expect(r.stdout).toContain('send_interactive');
      expect(r.stdout.toLowerCase()).toContain('usage');
    });

    it('--help -> help text, exit 0', async () => {
      const r = await runCli(['--help']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('channel Skill');
    });

    it('help subcommand -> help text, exit 0', async () => {
      const r = await runCli(['help']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('channel Skill');
    });

    it('unknown command -> help on stdout + note on stderr, exit 1', async () => {
      const r = await runCli(['bogus-command']);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('channel Skill');
      expect(r.stderr).toContain('Unknown command: bogus-command');
    });
  });

  // ==========================================================================
  // REST transport switch (Issue #4532 part 1)
  //
  // The CLI must reach the PrimaryNode over the REST API with NO Unix socket
  // and no IPC fallback. It does so by setting DISCLAUDE_REST_IPC_ENABLED=true
  // (plus the resolved base URL) BEFORE the first channel implementation import;
  // core getIpcClient() and the channel CLI isIpcAvailable() probe then select
  // the REST branch (RestIpcClient / GET /api/ping).
  //
  // These tests run WITHOUT a PrimaryNode: the REST face at the base URL is
  // simply down (nothing listens on the loopback ports used below), which is
  // exactly the #4532 scope-3 scenario — the CLI must report an actionable
  // "start the main service" hint, not a raw fetch ECONNREFUSED.
  //
  // Port strategy: bind a listener on 127.0.0.1:0 to reserve an ephemeral
  // port, close it, and use it as the base URL. The reservation makes an
  // accidental collision with a real service vanishingly unlikely within the
  // test's lifetime.
  // ==========================================================================
  describe('REST transport switch (#4532)', () => {
    /** Reserve an ephemeral loopback port, release it, and return it. */
    async function reserveEphemeralPort(): Promise<number> {
      const net = await import('node:net');
      return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
          const addr = srv.address();
          const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
          srv.close(() => resolve(port));
        });
        srv.on('error', reject);
      });
    }

    it('send_text against a down REST face -> actionable hint with the base URL, exit 1', async () => {
      const port = await reserveEphemeralPort();
      const baseUrl = `http://127.0.0.1:${port}`;
      const r = await runCli(
        [
          'send_text',
          '--chat',
          'oc_test0123456789012345678901234567890',
          '--text',
          'hi',
          '--base-url',
          baseUrl,
        ],
        { NODE_ENV: 'test', HOME: '/nonexistent-home-4532' }
      );
      expect(r.code).toBe(1);
      // stdout stays exactly one JSON object — the transport switch does not
      // break the output contract even when the REST face is down.
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_text' });
      // The actionable hint names the base URL and how to fix it (#4532 scope 3)…
      expect(String(obj.hint)).toContain(baseUrl);
      expect(String(obj.hint)).toMatch(/start the main service|--api-port/);
      // …and the error is NOT a bare fetch stack: the CLI surfaced the mapped
      // IPC-contract message (IPC service unavailable), not ENOTFOUND noise.
      expect(String(obj.error)).not.toMatch(/ENOTFOUND|at /);
    }, 30000);

    it('send_text with missing local credentials and a down REST face -> actionable hint', async () => {
      const port = await reserveEphemeralPort();
      const baseUrl = `http://127.0.0.1:${port}`;
      const r = await runCli(
        ['send_text', '--chat', 'oc_test0123456789012345678901234567890', '--text', 'hi', '--base-url', baseUrl],
        {
          NODE_ENV: 'test',
          HOME: '/nonexistent-home-4532',
          DISCLAUDE_CONFIG_PATH: '/nonexistent-config-4532.yaml',
          FEISHU_APP_ID: '',
          FEISHU_APP_SECRET: '',
        }
      );
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      // The CLI deliberately skips local credential validation: PrimaryNode
      // owns the runtime credentials. A down REST face must therefore surface
      // the transport failure, not the obsolete local-credentials error.
      expect(String(obj.error)).toMatch(/IPC|REST|服务不可用|unavailable/i);
      expect(String(obj.error)).not.toContain('Feishu credentials not configured');
      expect(String(obj.hint)).toContain(baseUrl);
      expect(String(obj.hint)).toMatch(/start the main service|--api-port/);
    }, 30000);

    it('send_text honors DISCLAUDE_REST_IPC_BASE_URL when --base-url is absent (#4532 scope 2)', async () => {
      const port = await reserveEphemeralPort();
      const baseUrl = `http://127.0.0.1:${port}`;
      const r = await runCli(
        ['send_text', '--chat', 'oc_test0123456789012345678901234567890', '--text', 'hi'],
        { NODE_ENV: 'test', HOME: '/nonexistent-home-4532', DISCLAUDE_REST_IPC_BASE_URL: baseUrl }
      );
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_text' });
      // The hint reflects the env-var base URL — proving the env wiring
      // reached the transport, not just the flag path.
      expect(String(obj.hint)).toContain(baseUrl);
    }, 30000);

    it('push_to_agent against a down REST face -> actionable hint, exit contract intact', async () => {
      const port = await reserveEphemeralPort();
      const baseUrl = `http://127.0.0.1:${port}`;
      const r = await runCli(
        [
          'push_to_agent',
          '--chat',
          'oc_test0123456789012345678901234567890',
          '--message',
          'hi',
          '--base-url',
          baseUrl,
        ],
        { NODE_ENV: 'test', HOME: '/nonexistent-home-4532' }
      );
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'push_to_agent' });
      expect(String(obj.hint)).toContain(baseUrl);
      expect(String(obj.hint)).toMatch(/start the main service|--api-port/);
    }, 30000);
  });
});
