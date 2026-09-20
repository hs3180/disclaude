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
    expect(events.map(event => event.type)).toEqual(expect.arrayContaining([
      'worker-init-error',
      'allocation-failed',
      'revoking',
      'reclaimed',
    ]));
    await coordinator.close();
  });
});
