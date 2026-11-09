/**
 * Tests for the mini-swe-agent subprocess runner (Issue #5006).
 *
 * These exercise the REAL subprocess machinery (spawn / readline / timers /
 * signals) against fake `mini` shell scripts on an injected PATH — no mocking
 * of the mechanism under test:
 * - happy path: stdout lines forwarded in order; exit 0 result fields
 * - argv contract: -y --exit-immediately -o <trajectory> [-m <model>] -t <prompt>
 * - stderr forwarded chunk-wise + captured in the rolling tail
 * - non-zero exit surfaced via exitCode + stderrTail
 * - explicit per-run timeout: SIGTERM kills a sleeping script, timedOut=true
 * - abort(): kill in-flight run, aborted=true
 * - spawn failure (missing binary): spawnError with ENOENT
 * - prompt-too-long guard: actionable spawnError without spawning
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MiniSweRunner } from './runner.js';

interface ScriptedBinary {
  binDir: string;
  binaryPath: string;
  capturePath: string;
  markerPath: string;
  readyPath: string;
  cleanup: () => void;
}

/**
 * Write a fake `mini` executable running the given shell body.
 *
 * Signal-handling notes (verified against macOS bash 3.2 = /bin/sh, same as
 * codex-runner.test.ts): the trap must `exit`; a foreground `sleep` defers
 * trapped signals, so sleeping bodies use the background+`wait` pattern; the
 * READY marker is touched once the trap is installed so tests wait for
 * signal-readiness instead of guessing a delay.
 */
function makeScriptedBinary(body: string): ScriptedBinary {
  const root = mkdtempSync(join(tmpdir(), 'mini-runner-test-'));
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const binaryPath = join(binDir, 'mini');
  const capturePath = join(root, 'capture.log');
  const markerPath = join(root, 'killed.marker');
  const readyPath = join(root, 'ready.marker');
  writeFileSync(
    binaryPath,
    `#!/bin/sh\nCAPTURE="${capturePath}"\nMARKER="${markerPath}"\nREADY="${readyPath}"\n` +
      `trap 'touch "$MARKER"; exit 143' TERM\ntouch "$READY"\n${body}\n`,
    { mode: 0o755 },
  );
  chmodSync(binaryPath, 0o755);
  return {
    binDir,
    binaryPath,
    capturePath,
    markerPath,
    readyPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Sleeping body that honors TERM promptly (background + wait). */
const SLEEP_BODY = 'sleep 30 >/dev/null 2>&1 &\nwait $!';

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor condition not met within timeout');
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe('MiniSweRunner (Issue #5006)', () => {
  let fixture: ScriptedBinary;

  beforeEach(() => {
    fixture = makeScriptedBinary('exit 0');
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('forwards stdout lines in order and resolves a clean exit', async () => {
    fixture.cleanup();
    fixture = makeScriptedBinary(`echo 'step one'
echo ''
echo 'step two'`);
    const lines: string[] = [];
    const run = new MiniSweRunner({ binary: fixture.binaryPath }).run(
      { prompt: 'do the task', trajectoryPath: join(fixture.binDir, '..', 't.traj.json') },
      line => lines.push(line),
    );
    const result = await run.promise;
    expect(lines).toEqual(['step one', 'step two']);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, aborted: false });
    expect(result.stdoutTail).toContain('step two');
  });

  it('builds the documented headless argv: -y --exit-immediately -o <traj> [-m model] -t <prompt>', async () => {
    fixture.cleanup();
    fixture = makeScriptedBinary('echo "argv:$*" >> "$CAPTURE"');
    const trajectoryPath = join(fixture.binDir, 'turn-1.traj.json');
    const run = new MiniSweRunner({ binary: fixture.binaryPath }).run(
      { prompt: 'fix the bug', model: 'openai/gpt-test', trajectoryPath },
      () => {},
    );
    const result = await run.promise;
    expect(result.exitCode).toBe(0);
    const captured = readFileSync(fixture.capturePath, 'utf8');
    expect(captured).toContain('-y');
    expect(captured).toContain('--exit-immediately');
    expect(captured).toContain(`-o ${trajectoryPath}`);
    expect(captured).toContain('-m openai/gpt-test');
    expect(captured.trim().endsWith('-t fix the bug')).toBe(true);
  });

  it('omits -m when no model is selected', async () => {
    fixture.cleanup();
    fixture = makeScriptedBinary('echo "argv:$*" >> "$CAPTURE"');
    await new MiniSweRunner({ binary: fixture.binaryPath }).run(
      { prompt: 'task', trajectoryPath: join(fixture.binDir, 't.traj.json') },
      () => {},
    ).promise;
    const captured = readFileSync(fixture.capturePath, 'utf8');
    expect(captured).not.toContain('-m');
  });

  it('forwards stderr chunk-wise and keeps the rolling tail for error mapping', async () => {
    fixture.cleanup();
    fixture = makeScriptedBinary(`echo 'diagnostic one' >&2
echo 'out'
echo 'diagnostic two' >&2
exit 3`);
    const stderrChunks: string[] = [];
    const run = new MiniSweRunner({ binary: fixture.binaryPath }).run(
      { prompt: 'task', trajectoryPath: join(fixture.binDir, 't.traj.json'), stderr: chunk => stderrChunks.push(chunk) },
      () => {},
    );
    const result = await run.promise;
    expect(result.exitCode).toBe(3);
    expect(stderrChunks.join('')).toContain('diagnostic one');
    expect(result.stderrTail).toContain('diagnostic two');
  });

  it('kills a sleeping child at the per-run timeout with timedOut=true', async () => {
    fixture.cleanup();
    fixture = makeScriptedBinary(SLEEP_BODY);
    const run = new MiniSweRunner({ binary: fixture.binaryPath, timeoutMs: 300 }).run(
      { prompt: 'task', trajectoryPath: join(fixture.binDir, 't.traj.json') },
      () => {},
    );
    const result = await run.promise;
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(existsSync(fixture.markerPath)).toBe(true);
  });

  it('abort() kills an in-flight run and reports aborted=true', async () => {
    fixture.cleanup();
    fixture = makeScriptedBinary(SLEEP_BODY);
    const run = new MiniSweRunner({ binary: fixture.binaryPath }).run(
      { prompt: 'task', trajectoryPath: join(fixture.binDir, 't.traj.json') },
      () => {},
    );
    await waitFor(() => existsSync(fixture.readyPath));
    run.handle.abort();
    const result = await run.promise;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(existsSync(fixture.markerPath)).toBe(true);
  });

  it('resolves a spawn error with an actionable ENOENT for a missing binary', async () => {
    const run = new MiniSweRunner({ binary: join(fixture.binDir, 'no-such-mini') }).run(
      { prompt: 'task', trajectoryPath: join(fixture.binDir, 't.traj.json') },
      () => {},
    );
    const result = await run.promise;
    expect(result.exitCode).toBeNull();
    expect(result.spawnError).toBeInstanceOf(Error);
    expect((result.spawnError as NodeJS.ErrnoException).code).toBe('ENOENT');
  });

  it('rejects an oversized prompt before spawning', async () => {
    const before = existsSync(fixture.readyPath);
    const run = new MiniSweRunner({ binary: fixture.binaryPath }).run(
      { prompt: 'x'.repeat(200_000), trajectoryPath: join(fixture.binDir, 't.traj.json') },
      () => {},
    );
    const result = await run.promise;
    expect(result.spawnError).toBeInstanceOf(Error);
    expect(result.spawnError?.message).toContain('prompt too long');
    expect(result.durationMs).toBe(0);
    expect(before).toBe(false);
    expect(existsSync(fixture.readyPath)).toBe(false);
  });
});
