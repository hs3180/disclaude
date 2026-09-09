import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeepSeekHarnessProvider } from './provider.js';

async function sdkFixture(): Promise<{ dir: string; binary: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-provider-'));
  const binary = join(dir, 'dsh');
  await writeFile(
    binary,
    `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\\n');
rl.on('line', line => {
  const req = JSON.parse(line);
  if (req.method === 'initialize') { reply(req.id, { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } }); return; }
  if (req.method === 'shutdown') { reply(req.id, {}); process.exit(0); return; }
  const sid = req.params.sessionId;
  reply(req.id, { messageId: 'user-1' });
  notify('session.event', { sessionId: sid, event: { type: 'tool/call', data: { callId: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' } } });
  notify('session.event', { sessionId: sid, event: { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'file data' }] }] } } } });
  notify('session.event', { sessionId: sid, event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'done' } } } });
  notify('session.event', { sessionId: sid, event: { type: 'assistant/message', data: { message: { id: 'assistant-1', content: [{ type: 'text', text: 'done' }] } } } });
  notify('session.event', { sessionId: sid, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } });
});
`,
    { mode: 0o755 }
  );
  return { dir, binary };
}

async function* oneInput() {
  yield { role: 'user' as const, content: 'read it' };
}

describe('DeepSeekHarnessProvider (Issue #4741)', () => {
  it('allows dsh to resolve credentials from its own credential service', () => {
    const provider = new DeepSeekHarnessProvider({ env: {} });

    expect(provider.validateConfig()).toBe(true);
    expect(provider.getInfo()).toMatchObject({
      name: 'deepseek',
      available: true,
    });
  });

  it('accepts an API key and an existing isolated DSH_HOME', () => {
    const provider = new DeepSeekHarnessProvider({
      env: { DEEPSEEK_API_KEY: 'test-key' },
      dshHome: process.cwd(),
    });

    expect(provider.validateConfig()).toBe(true);
    expect(provider.getInfo()).toMatchObject({
      name: 'deepseek',
      version: '0.0.0-harness-preview',
      available: true,
    });
  });

  it('streams an official-protocol prompt through native tool events to one completion', async () => {
    const fixture = await sdkFixture();
    const provider = new DeepSeekHarnessProvider({ apiKey: 'test-key', binary: fixture.binary });
    try {
      const { iterator } = provider.queryStream(oneInput(), {
        cwd: fixture.dir,
        model: 'deepseek-chat',
        sessionKey: 'chat-1',
        settingSources: [],
      });
      const events = [];
      for await (const event of iterator) {
        events.push(event);
      }
      expect(events.map((event) => event.type)).toEqual([
        'tool_use',
        'tool_result',
        'text',
        'result',
      ]);
      expect(events[0]?.metadata).toMatchObject({
        toolName: 'read_file',
        toolInput: { path: 'a.txt' },
      });
      expect(events[1]).toMatchObject({ content: 'file data' });
      expect(events.filter((event) => event.type === 'result')).toHaveLength(1);
    } finally {
      provider.dispose();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('fails fast when unsupported client tool controls are requested', () => {
    const provider = new DeepSeekHarnessProvider({ apiKey: 'test-key' });
    expect(() =>
      provider.queryStream(oneInput(), { settingSources: [], allowedTools: ['Read'] })
    ).toThrow(/does not support client tool registration/);
    expect(() => provider.createInlineTool({} as never)).toThrow(
      /no inline-tool registration method/
    );
  });

  it('cancels before startup and releases the child without hanging the iterator', async () => {
    const fixture = await sdkFixture();
    const provider = new DeepSeekHarnessProvider({ apiKey: 'test-key', binary: fixture.binary });
    try {
      const query = provider.queryStream(oneInput(), {
        settingSources: [],
        sessionKey: 'cancel-me',
      });
      query.handle.cancel();
      await expect(query.iterator.next()).resolves.toMatchObject({ done: true });
    } finally {
      provider.dispose();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('becomes unavailable after disposal', () => {
    const provider = new DeepSeekHarnessProvider({ apiKey: 'test-key' });

    provider.dispose();

    expect(provider.validateConfig()).toBe(false);
  });
});
