import { describe, expect, it } from 'vitest';
import { Coordinator } from './coordinator.mjs';

describe('browser coordinator startup diagnostics', () => {
  it('records the worker init failure before rejecting the queued caller', async () => {
    const events = [];
    const coordinator = new Coordinator({
      url: 'ws://fixture.invalid',
      target: 'fixture-target',
      event: event => events.push(event),
      workerModule: new URL('./fixtures/coordinator-init-failure.mjs', import.meta.url),
      startupMs: 500,
      hardMs: 1000,
      ttlMs: 100,
    });

    await expect(coordinator.acquire('fixture-caller').promise).rejects.toThrow('fixture startup failed');
    await coordinator.close();
    expect(events.map(event => event.type)).toEqual(expect.arrayContaining([
      'worker-init-error',
      'allocation-failed',
      'revoking',
      'reclaimed',
    ]));
    expect(events.find(event => event.type === 'worker-init-error')).toMatchObject({ stderr: 'fixture init stderr' });
    expect(events.find(event => event.type === 'allocation-failed')).toMatchObject({ stderr: 'fixture init stderr' });
  });

  it('retains worker stderr when startup stops after the daemon announcement', async () => {
    const events = [];
    const coordinator = new Coordinator({
      url: 'ws://fixture.invalid',
      target: 'fixture-target',
      event: event => events.push(event),
      workerModule: new URL('./fixtures/coordinator-startup-timeout.mjs', import.meta.url),
      startupMs: 50,
      hardMs: 1000,
      ttlMs: 100,
    });

    await expect(coordinator.acquire('fixture-caller').promise).rejects.toThrow('Worker startup timeout');
    await coordinator.close();
    const timeout = events.find(event => event.type === 'worker-startup-timeout');
    const failed = events.find(event => event.type === 'allocation-failed');
    expect(events.find(event => event.type === 'daemon-started')).toMatchObject({ python: 'fixture-python', cwd: 'fixture-cwd' });
    expect(timeout).toMatchObject({ startupMs: 50, stderr: 'fixture startup stderr' });
    expect(failed).toMatchObject({ error: 'Worker startup timeout', stderr: 'fixture startup stderr' });
  });

  it('records supervised daemon exit details before the worker exits', async () => {
    const events = [];
    const coordinator = new Coordinator({
      url: 'ws://fixture.invalid',
      target: 'fixture-target',
      event: event => events.push(event),
      workerModule: new URL('./fixtures/coordinator-daemon-exit.mjs', import.meta.url),
      startupMs: 500,
      hardMs: 1000,
      ttlMs: 100,
    });

    await expect(coordinator.acquire('fixture-caller').promise).rejects.toThrow('Worker startup exit');
    await coordinator.close();
    expect(events.find(event => event.type === 'daemon-started')).toMatchObject({ pid: 4242, python: 'fixture-python', cwd: 'fixture-cwd' });
    expect(events.find(event => event.type === 'daemon-exit')).toMatchObject({ code: 2, signal: null });
  });

  it('quarantines instead of leaking a cleanup exception as an unhandled rejection', async () => {
    const events = [];
    const coordinator = new Coordinator({
      url: 'ws://fixture.invalid',
      target: 'fixture-target',
      event: event => events.push(event),
      workerModule: new URL('./fixtures/coordinator-ready.mjs', import.meta.url),
      cleanupWorker: () => { throw new Error('fixture cleanup failed'); },
    });

    const lease = await coordinator.acquire('fixture-caller').promise;
    await expect(coordinator.release(lease)).resolves.toBe(true);
    expect(events.find(event => event.type === 'quarantined')).toMatchObject({ phase: 'cleanup-worker', reason: 'fixture cleanup failed' });
    await expect(coordinator.acquire('later-caller').promise).rejects.toThrow('Coordinator unavailable');
    await coordinator.close();
  });
});
