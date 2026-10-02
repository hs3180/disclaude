import { describe, expect, it } from 'vitest';
import type { NativeAgentTool } from './native-tools.js';
import { ClaudeSDKProvider } from './providers/claude/provider.js';
import { CodexAgentProvider } from './providers/codex/provider.js';
import { PiAgentProvider } from './providers/pi/provider.js';

const tool: NativeAgentTool = {
  name: 'notebook_read_cell',
  description: 'Read current shared source',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  execute: () => Promise.resolve({}),
};

async function* input() {
  yield { role: 'user' as const, content: 'read the cell' };
}

describe('canonical native tool adapter boundary', () => {
  it.each([
    ['Claude', () => new ClaudeSDKProvider()],
    ['Codex', () => new CodexAgentProvider({ env: { PATH: '' } })],
    ['Pi', () => new PiAgentProvider()],
  ] as const)(
    '%s rejects unsupported native registration instead of silently omitting the tool',
    (name, create) => {
      const provider = create();
      try {
        expect(() =>
          provider.queryStream(input(), { settingSources: [], nativeTools: [tool] })
        ).toThrow(`${name} nativeTools adapter is not implemented`);
      } finally {
        provider.dispose();
      }
    }
  );
});
