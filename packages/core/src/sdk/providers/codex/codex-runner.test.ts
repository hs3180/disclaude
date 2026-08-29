/**
 * Tests for the codex exec subprocess runner — Issue #4630 (S2).
 *
 * These exercise the REAL subprocess machinery (spawn / readline / timers /
 * signals) against fake `codex` shell scripts on an injected PATH — no
 * mocking of the mechanism under test:
 * - happy path: JSONL lines parsed into events in order; exit 0
 * - non-JSON stdout lines tolerated (schema resilience)
 * - stderr forwarded chunk-wise + captured in the rolling tail
 * - non-zero exit surfaced via exitCode + stderrTail
 * - per-run timeout: SIGTERM kills a sleeping script, timedOut=true
 * - abort(): kill in-flight run, aborted=true
 * - spawn failure (missing binary): spawnError with ENOENT
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CodexExecRunner } from './codex-runner.js';
import type { CodexThreadEvent } from './exec-adapter.js';

interface ScriptedBinary {
  binDir: string;
  binaryPath: string;
  markerPath: string;
  readyPath: string;
  cleanup: () => void;
}

/** Write a fake `codex` executable running the given shell body. */
function makeScriptedBinary(body: string): ScriptedBinary {
  const root = mkdtempSync(join(tmpdir(), 'codex-runner-test-'));
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const binaryPath = join(binDir, 'codex');
  const markerPath = join(root, 'killed.marker');
  const readyPath = join(root, 'ready.marker');
  writeFileSync(
    binaryPath,
    // Signal-handling notes (verified against macOS bash 3.2 = /bin/sh):
    // - the trap must `exit` or the script keeps running post-signal;
    // - a foreground `sleep` DEFERS trapped signals until it finishes, so
    //   sleeping bodies must use the background+`wait` pattern (traps fire
    //   promptly during the wait builtin) — see the sleeping bodies below;
    // - sleeping children redirect stdio so they never hold the parent's
    //   pipes open (a pipe-holding grandchild delays the close event);
    // - the READY marker is touched once the trap is installed, so tests
    //   can wait for signal-readiness instead of guessing a delay.
    `#!/bin/sh\nMARKER="${markerPath}"\nREADY="${readyPath}"\n` +
      `trap 'touch "$MARKER"; exit 143' TERM\ntouch "$READY"\n${body}\n`,
    { mode: 0o755 },
  );
  chmodSync(binaryPath, 0o755);
  return {
    binDir,
    binaryPath,
    markerPath,
    readyPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Sleeping body that honors TERM promptly (background + wait, see above). */
const SLEEP_BODY = 'sleep 30 >/dev/null 2>&1 &\nwait $!';

const EVENTS_SCRIPT = `
cat <<'JSONL'
{"type":"thread.started","thread_id":"t-123"}
{"type":"turn.started"}

not-json banner line
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hello"}}
{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}
JSONL
`;

describe('CodexExecRunner (Issue #4630)', () => {
  let fixture: ScriptedBinary;

  beforeEach(() => {
    // Allocated per-test; tests that don't create one get a trivial script.
    fixture = makeScriptedBinary('exit 0');
  });

  afterEach(() => {
    fixture.cleanup();
  });

  const runWith = (
    body: string,
    runOptions: { timeoutMs?: number } = {},
  ): ReturnType<CodexExecRunner['run']> & { events: CodexThreadEvent[] } => {
    fixture.cleanup();
    fixture = makeScriptedBinary(body);
    const runner = new CodexExecRunner({
      binary: fixture.binaryPath,
      timeoutMs: runOptions.timeoutMs,
    });
    const events: CodexThreadEvent[] = [];
    return { ...runner.run({ prompt: 'hi' }, (ev) => events.push(ev)), events };
  };

  it('parses JSONL events in order and tolerates non-JSON lines', async () => {
    const { promise, events } = runWith(EVENTS_SCRIPT);
    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(events.map((e) => e.type)).toEqual([
      'thread.started',
      'turn.started',
      'item.completed',
      'turn.completed',
    ]);
    expect((events[0] as { thread_id: string }).thread_id).toBe('t-123');
  });

  it('forwards stderr chunks and keeps a tail for error mapping', async () => {
    const { promise } = runWith('echo "auth expired" >&2\nexit 3');
    const result = await promise;
    expect(result.exitCode).toBe(3);
    expect(result.stderrTail).toContain('auth expired');
  });

  it('maps spawn failure (ENOENT) onto spawnError, not a throw', async () => {
    const runner = new CodexExecRunner({ binary: '/nonexistent/codex-path' });
    const events: CodexThreadEvent[] = [];
    const { promise } = runner.run({ prompt: 'hi' }, (ev) => events.push(ev));
    const result = await promise;
    expect(result.spawnError).toBeInstanceOf(Error);
    expect(result.exitCode).toBeNull();
    expect(events).toEqual([]);
  });

  it('kills a stalled script on timeout (real SIGTERM → trap marker)', async () => {
    const { promise } = runWith(SLEEP_BODY, { timeoutMs: 800 });
    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(143); // the trap's graceful exit
    expect(existsSync(fixture.markerPath)).toBe(true);
  }, 15_000);

  it('escalates to SIGKILL when the child SURVIVES SIGTERM', async () => {
    // S2 review: the old `trap '' TERM` variant was a false positive —
    // /bin/sh (bash 3.2) still dies to SIGTERM itself within ~ms under
    // background+wait, so the escalation timer never ran and every
    // assertion passed on the wrong path. This body PROVES survival: the
    // trap touches SURVIVED without exiting, and the loop keeps waiting,
    // so only the grace timer's SIGKILL can end the run.
    fixture.cleanup();
    const root = mkdtempSync(join(tmpdir(), 'codex-runner-kill-'));
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    const binaryPath = join(binDir, 'codex');
    const survivedPath = join(root, 'survived.marker');
    const readyPath = join(root, 'ready.marker');
    writeFileSync(
      binaryPath,
      `#!/bin/sh\nSURVIVED="${survivedPath}"\nREADY="${readyPath}"\n` +
        // trap that does NOT exit: the shell survives SIGTERM…
        'trap \'touch "$SURVIVED"\' TERM\n' +
        // READY marks the trap INSTALLED — the TERM must only be sent
        // after this, else the default disposition kills the shell before
        // the trap exists (same lesson as the READY pattern above).
        'touch "$READY"\n' +
        // …and keeps waiting, so the escalation must be SIGKILL.
        'while true; do sleep 30 >/dev/null 2>&1 & wait $!; done\n',
      { mode: 0o755 },
    );
    chmodSync(binaryPath, 0o755);
    fixture = {
      binDir,
      binaryPath,
      markerPath: join(root, 'killed.marker'),
      readyPath,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
    const runner = new CodexExecRunner({ binary: binaryPath, timeoutMs: 5_000 });
    const { promise } = runner.run({ prompt: 'hi' }, () => {});
    // TERM fires at t=5s; by then READY (written before the loop) is long
    // established even under load.
    await waitFor(() => existsSync(readyPath));
    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull(); // SIGKILL — no graceful exit code
    expect(existsSync(survivedPath)).toBe(true); // PROOF it survived TERM
  }, 15_000);

  it('rejects an argv-overflowing prompt with an actionable spawnError', async () => {
    const runner = new CodexExecRunner({ binary: fixture.binaryPath });
    const { promise } = runner.run({ prompt: 'x'.repeat(200_000) }, () => {});
    const result = await promise;
    expect(result.spawnError).toBeInstanceOf(Error);
    expect(result.spawnError?.message).toMatch(/prompt too long/i);
    expect(result.exitCode).toBeNull();
  });

  it('abort() kills the in-flight run and reports aborted', async () => {
    const run = runWith(SLEEP_BODY);
    // Wait until the trap is actually installed (READY marker) — under
    // loaded CI a fixed delay races the script's signal-readiness.
    await waitFor(() => existsSync(fixture.readyPath));
    run.handle.abort();
    const result = await run.promise;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(existsSync(fixture.markerPath)).toBe(true);
  }, 15_000);

  it('passes the prompt as the trailing argv (visible to the script)', async () => {
    fixture.cleanup();
    fixture = makeScriptedBinary('echo "argv:$*" >&2\nexit 0');
    const runner = new CodexExecRunner({ binary: fixture.binaryPath });
    const events: CodexThreadEvent[] = [];
    const { promise } = runner.run(
      { prompt: 'do the thing' },
      (ev) => events.push(ev),
    );
    const result = await promise;
    expect(result.stderrTail).toContain(
      'argv:exec --json --skip-git-repo-check --ephemeral -- do the thing',
    );
  });
});


async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
