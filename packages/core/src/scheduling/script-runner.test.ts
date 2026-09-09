import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultScriptRunner,
  ScriptCancelledError,
  ScriptTimeoutError,
} from './scheduler.js';

const run = (script: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
  defaultScriptRunner(script, {
    timeoutMs: options.timeoutMs ?? 2000,
    env: { ...process.env },
    signal: options.signal ?? new AbortController().signal,
  });

describe('defaultScriptRunner real process lifecycle', () => {
  it('captures stdout and stderr from a successful process', async () => {
    await expect(run('printf out; printf err >&2')).resolves.toEqual({
      stdout: 'out',
      stderr: 'err',
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  });

  it('bounds captured diagnostics while continuing to drain output', async () => {
    const result = await run('yes x | head -c 70000; yes y | head -c 70000 >&2');
    expect(Buffer.byteLength(result.stdout)).toBe(64 * 1024);
    expect(Buffer.byteLength(result.stderr)).toBe(64 * 1024);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
  });

  it('rejects non-zero exits with bounded diagnostics attached', async () => {
    await expect(run('printf detail >&2; exit 7')).rejects.toMatchObject({
      message: expect.stringContaining('code 7'),
      stderr: 'detail',
      stderrTruncated: false,
    });
  });

  it('times out a real process', async () => {
    await expect(run('sleep 30', { timeoutMs: 30 })).rejects.toBeInstanceOf(ScriptTimeoutError);
  });

  it('does not spawn a pre-cancelled script', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'disclaude-script-preabort-'));
    const marker = join(dir, 'must-not-exist');
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(run(`touch '${marker}'`, { signal: controller.signal })).rejects.toBeInstanceOf(
        ScriptCancelledError,
      );
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('cancellation terminates the shell process group and child', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'disclaude-script-runner-'));
    const pidFile = join(dir, 'child.pid');
    const controller = new AbortController();
    try {
      const completion = run(`sleep 30 & echo $! > '${pidFile}'; wait`, { signal: controller.signal });
      let childPid = 0;
      await expect.poll(async () => {
        childPid = Number.parseInt(await readFile(pidFile, 'utf8').catch(() => '0'), 10);
        return childPid;
      }).toBeGreaterThan(0);

      controller.abort();
      await expect(completion).rejects.toBeInstanceOf(ScriptCancelledError);
      expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'waits for SIGKILL escalation when a child ignores TERM and closes stdio',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'disclaude-script-stubborn-'));
      const pidFile = join(dir, 'child.pid');
      const controller = new AbortController();
      const childProgram = [
        "const fs=require('fs')",
        "process.on('SIGTERM',()=>{})",
        `fs.writeFileSync('${pidFile}',String(process.pid))`,
        'process.stdout.destroy()',
        'process.stderr.destroy()',
        'setInterval(()=>{},1000)',
      ].join(';');
      try {
        const completion = run(`node -e "${childProgram}" & wait`, { signal: controller.signal });
        let childPid = 0;
        await expect.poll(async () => {
          childPid = Number.parseInt(await readFile(pidFile, 'utf8').catch(() => '0'), 10);
          return childPid;
        }).toBeGreaterThan(0);

        const cancelledAt = Date.now();
        controller.abort();
        await expect(completion).rejects.toBeInstanceOf(ScriptCancelledError);
        expect(Date.now() - cancelledAt).toBeGreaterThanOrEqual(900);
        expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
