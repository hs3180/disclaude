import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DeepSeekHarnessProvider } from '../../packages/core/src/sdk/providers/deepseek/provider.js';

const enabled = process.env.DISCLAUDE_E2E_DSH === '1';

describe('DeepSeek mode: create and read an actual workspace artifact', () => {
  it.skipIf(!enabled).each(['minimal', 'standard'] as const)('%s executes a tool and returns its result', async mode => {
    if (!process.env.DEEPSEEK_API_KEY || !process.env.DISCLAUDE_E2E_DSH_MODEL) {
      throw new Error('Enabled dsh E2E requires DEEPSEEK_API_KEY and DISCLAUDE_E2E_DSH_MODEL');
    }
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-mode-e2e-'));
    const home = await mkdtemp(join(tmpdir(), 'dsh-mode-home-'));
    const marker = `DSH_${randomUUID().replaceAll('-', '')}`;
    const provider = new DeepSeekHarnessProvider({ mode, dshHome: home, requestTimeoutMs: 90_000 });
    const query = provider.queryStream((async function* () {
      yield { role: 'user' as const, content: `Use a shell tool to write exactly ${marker} to mode-proof.txt in the current directory, then read it back. Reply only with the file content. Work only in this directory; do not access the network or send messages.` };
    })(), { cwd, model: process.env.DISCLAUDE_E2E_DSH_MODEL, sessionKey: 'same-logical-chat', settingSources: [] });
    const timer = setTimeout(() => query.handle.close(), 110_000);
    try {
      const events = [];
      for await (const event of query.iterator) { events.push(event); }
      expect((await readFile(join(cwd, 'mode-proof.txt'), 'utf8')).trim()).toBe(marker);
      expect(events.some(event => event.type === 'tool_use')).toBe(true);
      expect(events.some(event => event.type === 'tool_result')).toBe(true);
      expect(events.filter(event => event.type === 'text').map(event => event.content).join('')).toContain(marker);
      expect(events.at(-1)?.type).toBe('result');
      expect(events.at(-1)?.metadata?.terminatedReason).toBeUndefined();
    } finally {
      clearTimeout(timer); query.handle.close(); provider.dispose();
      await rm(cwd, { recursive: true, force: true }); await rm(home, { recursive: true, force: true });
    }
  }, 120_000);
});
