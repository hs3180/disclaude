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
// This file is the TEMPLATE for the remaining channel tools
// (send_interactive, send_file, push_to_agent) deferred to later parts of
// #4459: same spawn harness, same "exactly one JSON" assertions. send_card
// (part 5) reuses this harness below for its validation tests; the card
// preprocessing / send path needs a built PrimaryNode + creds and is covered
// by the channel-mcp handler tests, not here.
//
// Part 3 of #4459 — does not auto-close the parent issue.

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
  timeoutMs = 20000,
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
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`cli timed out after ${timeoutMs}ms (args: ${args.join(' ')})`));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
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
      const r = await runCli(['send_text', '--text', 'hi']);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_text' });
      expect(String(obj.error)).toMatch(/--chat/i);
    });

    it('missing text content', async () => {
      const r = await runCli(['send_text', '--chat', 'oc_test']);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_text' });
      expect(String(obj.error)).toMatch(/text/i);
    });

    it('invalid --mentions JSON', async () => {
      const r = await runCli(['send_text', '--chat', 'oc_test', '--text', 'hi', '--mentions', 'not-json']);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_text' });
      expect(String(obj.error)).toMatch(/mentions/i);
    });

    it('unreadable --text-file', async () => {
      const r = await runCli(['send_text', '--chat', 'oc_test', '--text-file', '/no/such/path/xyz']);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_text' });
      expect(String(obj.error)).toMatch(/text-file/i);
    });
  });

  describe('send_card validation failures — exactly one JSON, exit 1 (part 5)', () => {
    // These all fail in the cheap, pre-import validation path, so they need no
    // PrimaryNode, no creds, and no built @disclaude/mcp-server — they lock the
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
      const r = await runCli(['send_card', '--chat', 'oc_test']);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_card' });
      expect(String(obj.error)).toMatch(/card content|missing/i);
    });

    it('invalid --card JSON', async () => {
      const r = await runCli(['send_card', '--chat', 'oc_test', '--card', 'not-json']);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_card' });
      expect(String(obj.error)).toMatch(/invalid card json/i);
    });

    it('card is not an object (array rejected — mirrors handler guard)', async () => {
      const r = await runCli(['send_card', '--chat', 'oc_test', '--card', '[1,2,3]']);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout);
      expect(obj).toMatchObject({ ok: false, command: 'send_card' });
      expect(String(obj.error)).toMatch(/must be an object/i);
    });

    // Post-import validation path: an object card that fails isValidFeishuCard
    // (missing config/header). This imports @disclaude/mcp-server (so it needs
    // `npm run build`, like the redirect test below) but never reaches a pino
    // write — it locks the one-JSON teardown contract (cli.mjs exitWithCode /
    // resultEmitted): the failure JSON is the ONLY object on stdout even though
    // process.exit trips pino's sonic-boom "not ready" flush.
    it('invalid card structure (object missing config/header) — exactly one JSON', async () => {
      const r = await runCli(['send_card', '--chat', 'oc_test', '--card', '{"elements":[]}']);
      expect(r.code).toBe(1);
      const obj = parseSingleJson(r.stdout); // asserts stdout is exactly ONE JSON line
      expect(obj).toMatchObject({ ok: false, command: 'send_card' });
      expect(String(obj.error)).toMatch(/invalid card structure/i);
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
    it(
      'keeps the pino "send_text called" line off stdout (routed to stderr)',
      async () => {
        const r = await runCli(
          ['send_text', '--chat', 'oc_test', '--text', 'hi'],
          { NODE_ENV: 'test', LOG_LEVEL: 'debug' },
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
      },
      30000,
    );
  });

  describe('help / unknown-command surface', () => {
    it('no args -> help text, exit 0', async () => {
      const r = await runCli([]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('channel Skill');
      expect(r.stdout).toContain('send_text');
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
});
