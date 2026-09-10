import { describe, expect, it, vi } from 'vitest';
import { handleAgent } from './agent.js';
import type { ControlHandlerContext } from '../types.js';

function context(overrides: Partial<ControlHandlerContext['agentPool']> = {}): ControlHandlerContext {
  return {
    agentPool: {
      reset: vi.fn(), stop: vi.fn(),
      listAgentPresets: () => [
        { name: 'default', agentBackend: 'claude', model: 'claude-sonnet' },
        { name: 'fast', agentBackend: 'pi', model: 'glm-fast' },
      ],
      getActiveAgentPreset: () => ({ name: 'default', agentBackend: 'claude', model: 'claude-sonnet' }),
      switchAgentPreset: () => ({ ok: true, active: { name: 'fast', agentBackend: 'pi', model: 'glm-fast' }, sessionBoundary: 'new-session' }),
      ...overrides,
    },
    node: { nodeId: 'node', getDebugGroup: () => null, setDebugGroup: vi.fn(), clearDebugGroup: () => null },
  };
}

describe('/agent', () => {
  it('lists configured presets and marks the active one', async () => {
    const result = await handleAgent({ type: 'agent', chatId: 'a', data: { subcommand: 'list' } }, context());
    expect(result).toMatchObject({ success: true });
    expect(result.message).toContain('→ **default** — claude / claude-sonnet');
    expect(result.message).toContain('**fast** — pi / glm-fast');
  });

  it('reports the fresh-session and process-lifetime boundaries after switching', async () => {
    const result = await handleAgent({ type: 'agent', chatId: 'a', data: { subcommand: 'use', preset: 'fast' } }, context());
    expect(result).toMatchObject({ success: true });
    expect(result.message).toContain('pi / glm-fast');
    expect(result.message).toContain('context is not migrated');
    expect(result.message).toContain('service restarts');
  });

  it('returns a switch failure without claiming the active preset changed', async () => {
    const result = await handleAgent(
      { type: 'agent', chatId: 'a', data: { subcommand: 'use', preset: 'missing' } },
      context({ switchAgentPreset: () => ({ ok: false, error: 'Unknown agent preset: missing' }) })
    );
    expect(result).toEqual({ success: false, message: 'Unknown agent preset: missing' });
  });
});
