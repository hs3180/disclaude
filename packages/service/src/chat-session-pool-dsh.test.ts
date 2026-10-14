import { describe, expect, it, vi } from 'vitest';
import type { AgentPreset } from '@disclaude/core';

const native = vi.hoisted(() => ({
  getProvider: vi.fn(),
  getInfo: vi.fn(() => ({ available: true })),
  forgetSession: vi.fn(),
}));
vi.mock('@disclaude/core', async importOriginal => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    getProvider: native.getProvider,
    Config: class extends actual.Config {
      static getAgentPresets() { return undefined; }
    },
  };
});
vi.mock('./agents/factory.js', () => ({
  AgentFactory: { resolveConfig: (options: unknown) => options },
}));

import { ChatSessionPool } from './chat-session-pool.js';

describe('named DSH pool routing', () => {
  it('uses the selected DSH connection for both switch preflight and reset', () => {
    const selected: AgentPreset = {
      agentBackend: 'dsh', llm: 'glm-native', model: 'glm-5.3', apiKey: '',
      dsh: { mode: 'minimal', provider: 'glm-proxy', dshHome: '/selected-home' },
    };
    native.getProvider.mockImplementation((_backend, settings) => {
      if (settings !== selected) {
        throw new Error('Default DSH settings were used');
      }
      return { getInfo: native.getInfo, forgetSession: native.forgetSession };
    });
    const pool = new ChatSessionPool({ agentPresets: {
      codex: { agentBackend: 'codex', llm: 'daily', model: 'gpt-6-luna', apiKey: '', default: true },
      dsh: selected,
    } });
    expect(pool.switchAgentPreset('test-chat', 'dsh')).toMatchObject({ ok: true });
    expect(native.getInfo).toHaveBeenCalledWith(expect.objectContaining({ settings: selected }));
    pool.reset('test-chat');
    expect(native.forgetSession).toHaveBeenCalledWith('test-chat');
    expect(native.getProvider).toHaveBeenLastCalledWith('dsh', selected);
  });
});
