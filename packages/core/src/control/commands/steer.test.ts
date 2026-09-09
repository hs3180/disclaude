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
      context(() => ({ ok: false, error: 'Immediate steer unsupported; instruction was not queued.' }))
    );
    expect(result).toEqual({ success: false, message: 'Immediate steer unsupported; instruction was not queued.' });
  });

  it('requires an instruction', async () => {
    expect(await handleSteer(
      { type: 'steer', chatId: 'chat', data: { prompt: '' } }, context()
    )).toEqual({ success: false, message: 'Usage: `/steer <instruction>`' });
  });
});
