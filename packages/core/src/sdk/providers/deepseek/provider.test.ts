import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DeepSeekHarnessProvider } from './provider.js';
import type { NativeAgentTool } from '../../native-tools.js';

function nativeTool(execute: NativeAgentTool['execute']): NativeAgentTool {
  return {
    name: 'notebook_read_cell',
    description: 'Read current source',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object' },
    execute,
  };
}

async function collect(iterator: ReturnType<DeepSeekHarnessProvider['queryStream']>['iterator']) {
  const events = [];
  for await (const event of iterator) {
    events.push(event);
  }
  return events;
}

async function sdkFixture(
  options: { foreignSession?: boolean } = {}
): Promise<{ dir: string; binary: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-provider-'));
  const binary = join(dir, 'dsh');
  await writeFile(
    binary,
    `#!/usr/bin/env node
require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(dir)}, 'argv.json'), JSON.stringify(process.argv.slice(2)));
const rl = require('node:readline').createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\\n');
const seen = new Set();
let initialization;
let pendingHost;
let pendingCancel;
const fs = require('node:fs');
const path = require('node:path');
const root = ${JSON.stringify(dir)};
const end = sid => {
  notify('session.event', { sessionId: sid, event: { type: 'assistant/message', data: { message: { id: 'assistant-1', content: [{ type: 'text', text: 'done' }] } } } });
  notify('session.event', { sessionId: sid, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } });
  notify('session.status', { sessionId: sid, status: 'idle' });
};
rl.on('line', line => {
  const req = JSON.parse(line);
  if (!req.method && req.id === 'host-1') {
    fs.writeFileSync(path.join(root, 'host-response.json'), JSON.stringify(req));
    const sid = pendingHost;
    notify('session.event', { sessionId: sid, event: { type: 'tool/result', data: { meta: req.result, message: { content: [{ type: 'tool-result', toolCallId: 'call-1', isError: !!req.error, content: [{ type: 'text', text: JSON.stringify(req.result || req.error) }] }] } } } });
    if (pendingCancel !== undefined) {
      notify('session.event', { sessionId: sid, event: { type: 'turn/end', data: { reason: { kind: 'aborted' } } } });
      notify('session.status', { sessionId: sid, status: 'idle' });
      reply(pendingCancel, { reasoningStopped: true });
    } else end(sid);
    pendingHost = undefined;
    return;
  }
  fs.appendFileSync(path.join(root, 'requests.jsonl'), JSON.stringify(req) + '\\n');
  if (req.method === 'initialize') {
    initialization = req.params;
    reply(req.id, { capabilities: { nativeTools: true, resume: true, cancel: true } }); return;
  }
  if (req.method === 'shutdown') { reply(req.id, {}); process.exit(0); return; }
  const sid = req.params.sessionId;
  if (req.method === 'session/open') {
    try {
      if (req.params.resume) fs.readFileSync(path.join(root, sid));
      else fs.writeFileSync(path.join(root, sid), '', { flag: 'wx' });
    }
    catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'native session missing or already exists' } }) + '\\n'); return; }
    seen.add(sid);
    reply(req.id, { sessionId: sid, resumed: req.params.resume }); return;
  }
  if (req.method === 'session/cancel') {
    if (pendingHost) {
      pendingCancel = req.id;
      notify('native_tool.cancel', { sessionId: sid, invocationId: 'call-1' });
    } else reply(req.id, { reasoningStopped: true });
    return;
  }
  if (req.method !== 'session/prompt' || !seen.has(sid)) throw new Error('unknown or unopened session');
  reply(req.id, { messageId: 'user-1' });
  if (initialization.nativeTools.length) {
    pendingHost = sid;
    const tool = initialization.nativeTools[0];
    notify('session.event', { sessionId: sid, event: { type: 'tool/call', data: { callId: 'call-1', name: tool.name, arguments: '{}' } } });
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'host-1', method: 'native_tool.call', params: { sessionId: ${options.foreignSession ? "'foreign-session'" : 'sid'}, name: tool.name, input: {}, invocationId: 'call-1' } }) + '\\n');
    return;
  }
  notify('session.event', { sessionId: sid, event: { type: 'tool/call', data: { callId: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' } } });
  notify('session.event', { sessionId: sid, event: { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'file data' }] }] } } } });
  notify('session.event', { sessionId: sid, event: { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'private reasoning' } } } });
  notify('session.event', { sessionId: sid, event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'do' } } } });
  notify('session.event', { sessionId: sid, event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'ne' } } } });
  notify('session.event', { sessionId: sid, event: { type: 'assistant/message', data: { message: { id: 'assistant-1', content: [{ type: 'text', text: 'done' }] } } } });
  notify('session.event', { sessionId: sid, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } });
  notify('session.status', { sessionId: sid, status: 'idle' });
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
  it.each([undefined, 'standard', 'minimal'] as const)(
    'selects the SDK profile for mode %s without changing the RPC flow',
    async (mode) => {
      const fixture = await sdkFixture();
      const provider = new DeepSeekHarnessProvider({
        binary: fixture.binary,
        dshHome: fixture.dir,
        mode,
      });
      try {
        const events = [];
        for await (const event of provider.queryStream(oneInput(), { settingSources: [] })
          .iterator) {
          events.push(event);
        }
        const argv = JSON.parse(await readFile(join(fixture.dir, 'argv.json'), 'utf8'));
        expect(argv.slice(0, 3)).toEqual([
          '--profile',
          mode === 'minimal' ? 'sdk-minimal' : 'sdk',
          '--patch',
        ]);
        expect(await readFile(argv[3], 'utf8')).toContain('disclaude-dsh-native-app');
        expect(events.at(-1)?.type).toBe('result');
      } finally {
        provider.dispose();
        await rm(fixture.dir, { recursive: true, force: true });
      }
    }
  );
  it('reports an unavailable minimal profile without retrying the standard profile', async () => {
    const fixture = await sdkFixture();
    await writeFile(
      fixture.binary,
      `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(join(fixture.dir, 'attempts'))}, JSON.stringify(process.argv.slice(2))+'\\n');\nprocess.exit(2);\n`,
      { mode: 0o755 }
    );
    const provider = new DeepSeekHarnessProvider({
      binary: fixture.binary,
      dshHome: fixture.dir,
      mode: 'minimal',
    });
    try {
      await expect(
        provider.queryStream(oneInput(), { settingSources: [] }).iterator.next()
      ).rejects.toThrow(/exited|sdk-minimal/);
      const attempts = (await readFile(join(fixture.dir, 'attempts'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(attempts).toHaveLength(1);
      expect(attempts[0].slice(0, 2)).toEqual(['--profile', 'sdk-minimal']);
    } finally {
      provider.dispose();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
  it('rejects invalid modes and custom arguments that could override the selected mode', () => {
    expect(() => new DeepSeekHarnessProvider({ mode: 'typo' as never })).toThrow('deepseek.mode');
    expect(
      () => new DeepSeekHarnessProvider({ mode: 'minimal', args: ['--profile', 'sdk'] })
    ).toThrow('custom process args');
  });
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
      version: '0.1.2-native',
      available: true,
    });
  });

  it('streams an official-protocol prompt through native tool events to one completion', async () => {
    const fixture = await sdkFixture();
    const provider = new DeepSeekHarnessProvider({
      apiKey: 'test-key',
      binary: fixture.binary,
      dshHome: fixture.dir,
    });
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
      expect(events.filter((event) => event.type === 'text').map((event) => event.content)).toEqual(
        ['done']
      );
    } finally {
      provider.dispose();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it.each(['completion', 'cancellation'])(
    'resumes the durable ID for the same logical chat after %s',
    async (ending) => {
      const fixture = await sdkFixture();
      const provider = new DeepSeekHarnessProvider({
        binary: fixture.binary,
        dshHome: fixture.dir,
      });
      try {
        const first = provider.queryStream(oneInput(), {
          sessionKey: 'same-chat',
          settingSources: [],
        });
        for await (const event of first.iterator) {
          if (ending === 'cancellation' && event.type === 'tool_use') {
            first.handle.cancel();
            break;
          }
        }
        const second = provider.queryStream(oneInput(), {
          sessionKey: 'same-chat',
          settingSources: [],
        });
        // A late close of the old stream must not kill the replacement process.
        first.handle.close();
        const events = [];
        for await (const event of second.iterator) {
          events.push(event);
        }
        expect(second.handle.sessionId).toBe(first.handle.sessionId);
        expect(events.filter((event) => event.type === 'result')).toHaveLength(1);
        expect(events.some((event) => event.type === 'error')).toBe(false);
      } finally {
        provider.dispose();
        await rm(fixture.dir, { recursive: true, force: true });
      }
    }
  );

  it('fails fast when unsupported client tool controls are requested', () => {
    const provider = new DeepSeekHarnessProvider({ apiKey: 'test-key' });
    expect(() => provider.queryStream(oneInput(), { settingSources: [], tools: [] })).toThrow(
      /legacy MCP\/inline/
    );
    expect(() => provider.createInlineTool({} as never)).toThrow(/inline-MCP wrappers/);
  });

  it('cancels before startup and releases the child without hanging the iterator', async () => {
    const fixture = await sdkFixture();
    const provider = new DeepSeekHarnessProvider({
      apiKey: 'test-key',
      binary: fixture.binary,
      dshHome: fixture.dir,
    });
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

  it('dispatches canonical native host tools and preserves structured results', async () => {
    const fixture = await sdkFixture();
    const provider = new DeepSeekHarnessProvider({
      binary: fixture.binary,
      dshHome: fixture.dir,
      provider: 'route-one',
    });
    const execute = vi.fn().mockResolvedValue({ runId: 'run-one', state: 'accepted' });
    try {
      const events = await collect(
        provider.queryStream(oneInput(), {
          settingSources: [],
          cwd: fixture.dir,
          model: 'native-model',
          reasoningEffort: 'native-effort',
          systemPrompt: 'Native instructions',
          nativeTools: [nativeTool(execute)],
        }).iterator
      );
      expect(execute).toHaveBeenCalledWith(
        {},
        { signal: expect.any(AbortSignal), invocationId: 'call-1' }
      );
      expect(events.find((event) => event.type === 'tool_result')?.metadata?.toolOutput).toEqual({
        runId: 'run-one',
        state: 'accepted',
      });
      const frames = (await readFile(join(fixture.dir, 'requests.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(frames[0].params).toMatchObject({
        provider: 'route-one',
        model: 'native-model',
        reasoningEffort: 'native-effort',
        systemPrompt: 'Native instructions',
      });
      expect(frames[0].params.nativeTools[0]).not.toHaveProperty('execute');
    } finally {
      await provider.shutdown();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('rejects a host request claiming a different session', async () => {
    const fixture = await sdkFixture({ foreignSession: true });
    const provider = new DeepSeekHarnessProvider({ binary: fixture.binary, dshHome: fixture.dir });
    const execute = vi.fn();
    try {
      await collect(
        provider.queryStream(oneInput(), { settingSources: [], nativeTools: [nativeTool(execute)] })
          .iterator
      );
      expect(execute).not.toHaveBeenCalled();
      expect(
        JSON.parse(await readFile(join(fixture.dir, 'host-response.json'), 'utf8')).error
      ).toMatchObject({ code: -32603 });
    } finally {
      await provider.shutdown();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('keeps the native reference across provider restart and drops it on explicit reset', async () => {
    const fixture = await sdkFixture();
    const options = { binary: fixture.binary, dshHome: fixture.dir };
    const queryOptions = { settingSources: [], cwd: fixture.dir, sessionKey: 'durable-chat' };
    const first = new DeepSeekHarnessProvider(options);
    const second = new DeepSeekHarnessProvider(options);
    try {
      const original = first.queryStream(oneInput(), queryOptions);
      await collect(original.iterator);
      await first.shutdown();
      const resumed = second.queryStream(oneInput(), queryOptions);
      await collect(resumed.iterator);
      expect(resumed.handle.sessionId).toBe(original.handle.sessionId);
      second.forgetSession('durable-chat');
      const reset = second.queryStream(oneInput(), queryOptions);
      await collect(reset.iterator);
      expect(reset.handle.sessionId).not.toBe(original.handle.sessionId);
      expect(await readFile(join(fixture.dir, original.handle.sessionId!), 'utf8')).toBe('');
    } finally {
      await first.shutdown();
      await second.shutdown();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('waits for owned tool cleanup before confirming interruption', async () => {
    const fixture = await sdkFixture();
    const provider = new DeepSeekHarnessProvider({ binary: fixture.binary, dshHome: fixture.dir });
    let entered!: () => void;
    let aborted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const signalled = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const quiescent = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cleaned = false;
    const tool = nativeTool(async (_input, { signal }) => {
      entered();
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted();
            resolve();
          },
          { once: true }
        );
      });
      await quiescent;
      cleaned = true;
      return { executionStop: 'not_confirmed' };
    });
    try {
      const query = provider.queryStream(oneInput(), { settingSources: [], nativeTools: [tool] });
      const events = collect(query.iterator);
      await started;
      let acknowledged = false;
      const interrupted = query.handle.interrupt!().then(() => {
        acknowledged = true;
      });
      await signalled;
      expect(acknowledged).toBe(false);
      expect(cleaned).toBe(false);
      release();
      await interrupted;
      expect(cleaned).toBe(true);
      expect((await events).find((event) => event.type === 'result')?.metadata?.stopReason).toBe(
        'interrupted'
      );
    } finally {
      release();
      await provider.shutdown();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
});
