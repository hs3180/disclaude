import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { devNull } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeAttemptProcess } from './attempt-process.js';

const command = (script: string) => ({ command: process.execPath, args: ['-e', script], env: process.env,
  signal: new AbortController().signal });
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

describe('owned Claude subprocess', () => {
  it('fences a deferred spawn even if SDK close throws', async () => {
    const owner = new ClaudeAttemptProcess();
    const result = await owner.stop(() => { throw new Error('control disconnected'); });
    expect(result).toMatchObject({ status: 'not-started', confirmed: true, closeFailed: true });
    expect(() => owner.spawn(command('process.exit(0)'))).toThrow('no longer accepts');
  });

  it.skipIf(process.platform === 'win32')('forces and confirms a stubborn owned child while preserving an unrelated group', async () => {
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'pipe' });
    const otherExit = once(other, 'exit');
    const stderr = vi.fn();
    const owner = new ClaudeAttemptProcess({ stderr, eofGraceMs: 20, termGraceMs: 30, killWaitMs: 1000 });
    const child = owner.spawn(command("process.on('SIGTERM', () => {}); process.stderr.write('owned diagnostic'); process.stdout.write('READY'); setInterval(() => {}, 1000)")) as ChildProcessWithoutNullStreams;
    const exited = once(child, 'exit');
    try {
      await once(child.stdout, 'data');
      const result = await owner.stop(() => { throw new Error('control disconnected'); });
      expect(result).toMatchObject({ pid: child.pid, status: 'killed', signal: 'SIGKILL', confirmed: true, closeFailed: true });
      expect(result.signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(alive(child.pid!)).toBe(false);
      expect(alive(other.pid!)).toBe(true);
      expect(stderr).toHaveBeenCalledWith('owned diagnostic');
      expect(await owner.stop()).toBe(result);
    } finally {
      child.kill('SIGKILL'); other.kill('SIGKILL');
      await Promise.all([exited, otherExit]);
    }
  });

  it.skipIf(process.platform === 'win32')('allows stdin EOF to finish the native process without forced signals', async () => {
    const owner = new ClaudeAttemptProcess({ eofGraceMs: 1000, termGraceMs: 20 });
    const child = owner.spawn(command("process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); process.stdout.write('READY')")) as ChildProcessWithoutNullStreams;
    const exited = once(child, 'exit');
    try {
      await once(child.stdout, 'data');
      expect(await owner.stop()).toMatchObject({ status: 'exited', confirmed: true, code: 0, signals: [] });
    } finally { child.kill('SIGKILL'); await exited; }
  });

  it('settles an actual OS spawn failure as not started', async () => {
    const owner = new ClaudeAttemptProcess({ eofGraceMs: 20, termGraceMs: 20 });
    const child = owner.spawn({ ...command(''), command: '/owned-missing-claude-binary' });
    await new Promise(resolve => child.once('error', resolve));
    expect(await owner.stop()).toMatchObject({ status: 'not-started', confirmed: true, pid: undefined });
  });

  it('reapplies provider environment routing after the SDK merge', async () => {
    const owner = new ClaudeAttemptProcess({ eofGraceMs: 1000 });
    const child = owner.spawn({ ...command(`process.stdout.write(JSON.stringify({
      guard: process.env.BH_RUNTIME_DIR, stale: process.env.BU_CDP_PORT,
      api: process.env.ANTHROPIC_API_KEY })); process.stdin.resume();
      process.stdin.on('end', () => process.exit(0));`),
    env: { ...process.env, BH_RUNTIME_DIR: '/owned-stale-browser', BU_CDP_PORT: '9911',
      ANTHROPIC_API_KEY: 'owned-selected-key' } }) as ChildProcessWithoutNullStreams;
    const exited = once(child, 'exit');
    try {
      const [data] = await once(child.stdout, 'data');
      expect(JSON.parse(String(data))).toEqual({ guard: devNull, api: 'owned-selected-key' });
      expect(await owner.stop()).toMatchObject({ status: 'exited', confirmed: true });
    } finally { child.kill('SIGKILL'); await exited; }
  });

  it.skipIf(process.platform === 'win32')('reclaims an observed tool group after its native parent exits', async () => {
    const toolScript = "process.on('SIGTERM', () => {}); process.stdout.write('READY'); setInterval(() => {}, 1000)";
    const parentScript = `const { spawn } = require('node:child_process');
const tool = spawn(process.execPath, ['-e', ${JSON.stringify(toolScript)}], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
tool.stdout.once('data', () => process.stdout.write(JSON.stringify({ toolPid: tool.pid })));
process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`;
    const owner = new ClaudeAttemptProcess({ eofGraceMs: 30, termGraceMs: 40, killWaitMs: 100 });
    const child = owner.spawn(command(parentScript)) as ChildProcessWithoutNullStreams;
    const exited = once(child, 'exit');
    let toolPid: number | undefined;
    try {
      const [data] = await once(child.stdout, 'data');
      const { toolPid: startedToolPid } = JSON.parse(String(data));
      toolPid = startedToolPid;
      expect(await owner.stop()).toMatchObject({ status: 'exited', code: 0, confirmed: true,
        signals: ['SIGTERM', 'SIGKILL'] });
      let state = '';
      try { state = execFileSync('ps', ['-p', String(toolPid), '-o', 'stat='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
      catch { /* PID no longer exists. */ }
      expect(state === '' || state.startsWith('Z')).toBe(true);
    } finally {
      child.kill('SIGKILL');
      if (toolPid) { try { process.kill(toolPid, 'SIGKILL'); } catch { /* Reaped. */ } }
      await exited;
    }
  });
});
