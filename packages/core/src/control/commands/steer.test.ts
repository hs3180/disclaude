import { describe, expect, it, vi } from 'vitest';
import { handleSteer } from './steer.js';
import type { ControlHandlerContext } from '../types.js';

function context(steer?: ControlHandlerContext['agentPool']['steer']): ControlHandlerContext {
  return {
    agentPool: { reset: vi.fn(), stop: vi.fn(), ...(steer ? { steer } : {}) },
    node: { nodeId: 'node', getDebugGroup: () => null, setDebugGroup: vi.fn(), clearDebugGroup: () => null },
  };
}

describe('/steer', () => {
  it('does not silently turn an unsupported steer into queued input', async () => {
    const result = await handleSteer(
      { type: 'steer', chatId: 'chat', data: { prompt: 'change direction' } },
      context(() => Promise.resolve({ ok: false, error: 'Immediate steer unsupported; instruction was not queued.' }))
    );
    expect(result).toEqual({ success: false, message: 'Immediate steer unsupported; instruction was not queued.' });
  });

  it('does not report success until the server acknowledgement resolves', async () => {
    let acknowledge!: (value: { ok: true; message: string }) => void;
    const result = Promise.resolve(handleSteer(
      { type: 'steer', chatId: 'chat', data: { prompt: 'change direction' } },
      context(() => new Promise((resolve) => { acknowledge = resolve; }))
    ));
    let settled = false;
    void result.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    acknowledge({ ok: true, message: 'acknowledged' });
    await expect(result).resolves.toEqual({ success: true, message: 'acknowledged' });
  });

  it('requires an instruction', async () => {
    expect(await handleSteer(
      { type: 'steer', chatId: 'chat', data: { prompt: '' } }, context()
    )).toEqual({ success: false, message: 'Usage: `/steer <instruction>`' });
  });
});
