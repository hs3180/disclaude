import { describe, expect, it, vi } from 'vitest';
import { Coordinator } from './coordinator.mjs';

function fakeSession(options, {
  startError,
  startDelay,
  stderr = 'fixture harness stderr',
  result = { result: { stdout: 'fixture output', stderr: '', code: 0, signal: null }, target: undefined },
  stopError,
} = {}) {
  const session = {
    stderr,
    daemon: { pid: 4242 },
    start: vi.fn(async () => {
      options.onEvent({ type: 'daemon-started', pid: 4242, python: options.python, cwd: options.cwd });
      if (startDelay) await startDelay;
      if (startError) throw new Error(startError);
      return { pid: 4242 };
    }),
    execute: vi.fn(async () => result),
    stop: vi.fn(async () => {
      if (stopError) throw new Error(stopError);
    }),
    exit(details = { code: 2, signal: null }) {
      session.daemonExitDetails = details;
      options.onEvent({ type: 'daemon-exit', ...details });
      options.onDaemonExit(details);
    },
  };
  return session;
}

describe('in-process browser coordinator', () => {
  it('records a Python daemon startup failure and cleans the lease runtime', async () => {
    const events = [];
    const cleanupRuntime = vi.fn();
    const session = {};
    const coordinator = new Coordinator({
      url: 'ws://fixture.invalid',
      target: 'fixture-target',
      event: event => events.push(event),
      sessionOptions: { python: 'fixture-python', cwd: 'fixture-cwd', runtime: 'fixture-runtime' },
      createSession: options => Object.assign(session, fakeSession(options, { startError: 'fixture startup failed' })),
      cleanupRuntime,
      startupMs: 500,
    });

    await expect(coordinator.acquire('fixture-caller').promise).rejects.toThrow('fixture startup failed');
    await coordinator.close();
    expect(events.map(event => event.type)).toEqual(expect.arrayContaining([
      'daemon-started',
      'allocation-failed',
      'revoking',
      'reclaimed',
    ]));
    expect(events.find(event => event.type === 'allocation-failed')).toMatchObject({
      stderr: 'fixture harness stderr',
    });
    expect(session.stop).toHaveBeenCalledOnce();
    expect(cleanupRuntime).toHaveBeenCalledWith({
      python: 'fixture-python',
      cwd: 'fixture-cwd',
      runtime: 'fixture-runtime',
    });
  });

  it('times out session startup, stops the session, and preserves diagnostics', async () => {
    const events = [];
    const session = {};
    const coordinator = new Coordinator({
      url: 'ws://fixture.invalid',
      target: 'fixture-target',
      event: event => events.push(event),
      createSession: options => Object.assign(session, fakeSession(options, { startDelay: new Promise(() => {}) })),
      startupMs: 10,
    });

    await expect(coordinator.acquire('fixture-caller').promise).rejects.toThrow('Browser harness startup timeout');
    await coordinator.close();
    expect(events.find(event => event.type === 'harness-startup-timeout')).toMatchObject({
      startupMs: 10,
      stderr: 'fixture harness stderr',
    });
    expect(session.stop).toHaveBeenCalledOnce();
  });

  it('runs scripts through the in-process session and updates the shared CDP target', async () => {
    const sessionRef = {};
    const onTargetChange = vi.fn();
    const sessionResult = {
      result: { stdout: 'script complete', stderr: '', code: 0, signal: null },
      target: 'updated-target',
    };
    const coordinator = new Coordinator({
      url: 'ws://fixture.invalid',
      target: 'fixture-target',
      createSession: options => Object.assign(sessionRef, fakeSession(options, { result: sessionResult })),
      onTargetChange,
      ttlMs: 5000,
      hardMs: 10000,
    });

    const lease = await coordinator.acquire('fixture-caller').promise;
    await expect(coordinator.execute(lease, 'script', { code: 'print(1)', cwd: '/tmp' })).resolves.toEqual(sessionResult.result);
    expect(sessionRef.execute).toHaveBeenCalledWith('print(1)', '/tmp');
    expect(onTargetChange).toHaveBeenCalledWith('updated-target');
    expect(coordinator.target).toBe('updated-target');
    await expect(coordinator.release(lease)).resolves.toBe(true);
    await coordinator.close();
  });

  it('reclaims an exited daemon before admitting the next queued caller', async () => {
    const events = [];
    const sessions = [];
    const verifyReclaimed = vi.fn(async () => {});
    const coordinator = new Coordinator({
      url: 'ws://fixture.invalid',
      target: 'fixture-target',
      event: event => events.push(event),
      createSession: options => {
        const session = fakeSession(options);
        sessions.push(session);
        return session;
      },
      verifyReclaimed,
      ttlMs: 5000,
      hardMs: 10000,
    });

    const first = await coordinator.acquire('first').promise;
    sessions[0].exit();
    await vi.waitFor(() => expect(events.some(event => event.type === 'reclaimed')).toBe(true));
    const second = await coordinator.acquire('second').promise;
    expect(sessions).toHaveLength(2);
    expect(verifyReclaimed).toHaveBeenCalledOnce();
    await coordinator.release(second);
    await coordinator.close();
    await expect(coordinator.release(first)).resolves.toBe(false);
  });

  it('quarantines when session shutdown or runtime cleanup cannot complete', async () => {
    const events = [];
    const coordinator = new Coordinator({
      url: 'ws://fixture.invalid',
      target: 'fixture-target',
      event: event => events.push(event),
      createSession: options => fakeSession(options),
      cleanupRuntime: async () => { throw new Error('fixture runtime cleanup failed'); },
      ttlMs: 5000,
      hardMs: 10000,
    });

    const lease = await coordinator.acquire('fixture-caller').promise;
    await expect(coordinator.release(lease)).resolves.toBe(true);
    expect(events.find(event => event.type === 'quarantined')).toMatchObject({
      phase: 'cleanup-runtime',
      reason: 'fixture runtime cleanup failed',
    });
    await expect(coordinator.acquire('later-caller').promise).rejects.toThrow('Coordinator unavailable');
    await coordinator.close();
  });
});
