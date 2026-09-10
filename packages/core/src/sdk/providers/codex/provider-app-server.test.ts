import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentQueryOptions, UserInput } from '../../types.js';
import { CodexAgentProvider } from './provider.js';

const dirs: string[] = [];
function providerFixture(
  body: string,
  transport: 'exec' | 'app-server' | undefined = 'app-server',
): { provider: CodexAgentProvider; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'codex-app-provider-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(join(home, 'auth.json'), '{}');
  const binary = join(bin, 'codex');
  writeFileSync(binary, `#!/bin/sh\n${body}`);
  chmodSync(binary, 0o755);
  return {
    dir,
    provider: new CodexAgentProvider({
      ...(transport ? { transport } : {}),
      env: { PATH: bin, CODEX_HOME: home },
      builtinsDir: dir,
    }),
  };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('CodexAgentProvider app-server transport', () => {
  it('maps the real notification path and awaits steer acknowledgement', async () => {
    const { provider } = providerFixture(`
read initialize; echo '{"id":1,"result":{}}'
read initialized
read thread; echo '{"id":2,"result":{"thread":{"id":"thread-1"}}}'
read start; echo '{"id":3,"result":{"turn":{"id":"turn-1"}}}'
read steer; echo '{"id":4,"result":{"turnId":"turn-1"}}'
echo '{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","item":{"id":"item-1","type":"agentMessage","text":"hello"}}}'
echo '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed"}}}'
`);
    let releaseInput: () => void = () => {};
    const result = provider.queryStream((async function* () {
      yield { role: 'user', content: 'first' } as UserInput;
      await new Promise<void>((resolve) => { releaseInput = resolve; });
    })(), {
      sessionKey: 'chat-1',
      cwd: '/tmp/project',
      model: 'gpt-5.6',
      permissionMode: 'default',
      settingSources: [],
    } as AgentQueryOptions);
    const messages: AgentMessage[] = [];
    const collecting = (async () => {
      for await (const message of result.iterator) {messages.push(message);}
    })();
    await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({
      type: 'status', metadata: expect.objectContaining({ messageId: 'turn-1' }),
    })));
    await expect(result.handle.steer?.('correction')).resolves.toEqual({ turnId: 'turn-1' });
    await vi.waitFor(() => expect(messages.some((message) => message.type === 'result')).toBe(true));
    releaseInput();
    await collecting;
    expect(result.handle.sessionId).toBe('thread-1');
    provider.dispose();
  });

  it('waits for cancellation completion before an immediate same-thread follow-up', async () => {
    const { provider } = providerFixture(`
read initialize; echo '{"id":1,"result":{}}'
read initialized
read thread; echo '{"id":2,"result":{"thread":{"id":"thread-1"}}}'
read start; echo '{"id":3,"result":{"turn":{"id":"turn-1"}}}'
read interrupt; echo '{"id":4,"error":{"code":-32600,"message":"no active turn to interrupt"}}'
/bin/sleep 0.05
echo '{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","item":{"id":"late","type":"agentMessage","text":"stale output"}}}'
echo '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"interrupted"}}}'
read next; echo '{"id":5,"result":{"turn":{"id":"turn-2"}}}'
echo '{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-2","item":{"id":"reply","type":"agentMessage","text":"resumed"}}}'
echo '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-2","status":"completed"}}}'
`);
    const options = { sessionKey: 'stop-resume', settingSources: [] } as AgentQueryOptions;
    const input = async function* () { yield { role: 'user', content: 'hello' } as UserInput; };
    try {
      const first = provider.queryStream(input(), options);
      const cancelled: AgentMessage[] = [];
      for await (const message of first.iterator) {
        cancelled.push(message);
        if (message.type === 'status') {first.handle.cancel();}
      }
      expect(cancelled.some(message => message.type === 'text' || message.type === 'result')).toBe(false);
      const second = provider.queryStream(input(), options);
      const resumed: AgentMessage[] = [];
      for await (const message of second.iterator) {resumed.push(message);}
      expect(resumed.filter(message => message.type === 'error')).toEqual([]);
      expect(resumed).toContainEqual(expect.objectContaining({ type: 'text', content: 'resumed' }));
      expect(second.handle.sessionId).toBe('thread-1');
    } finally {provider.dispose();}
  });

  it('keeps exec as the default transport', () => {
    const { provider } = providerFixture('exit 0', 'exec');
    const result = provider.queryStream((async function* () {
      yield { role: 'user', content: 'default' } as UserInput;
    })(), { settingSources: [] } as AgentQueryOptions);
    expect(result.handle.steer).toBeUndefined();
    result.handle.close();
    provider.dispose();
  });

  it('ignores another turn and wakes the iterator when the server exits after start ack', async () => {
    const { provider } = providerFixture(`
read initialize; echo '{"id":1,"result":{}}'
read initialized
read thread; echo '{"id":2,"result":{"thread":{"id":"thread-1"}}}'
read start; echo '{"id":3,"result":{"turn":{"id":"turn-1"}}}'
echo '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-other","status":"completed"}}}'
exit 7
`);
    const result = provider.queryStream((async function* () {
      yield { role: 'user', content: 'first' } as UserInput;
    })(), { sessionKey: 'chat-exit', settingSources: [] } as AgentQueryOptions);
    const messages: AgentMessage[] = [];
    for await (const message of result.iterator) {
      messages.push(message);
    }
    const error = messages.find((message) => message.type === 'error');
    expect(error?.content).toContain('exited (code=7');
    provider.dispose();
  });

  it('does not report an interrupted turn as complete', async () => {
    const { provider } = providerFixture(`
read initialize; echo '{"id":1,"result":{}}'
read initialized
read thread; echo '{"id":2,"result":{"thread":{"id":"thread-1"}}}'
read start; echo '{"id":3,"result":{"turn":{"id":"turn-1"}}}'
echo '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"interrupted"}}}'
`);
    const result = provider.queryStream((async function* () {
      yield { role: 'user', content: 'first' } as UserInput;
    })(), { sessionKey: 'chat-stop', settingSources: [] } as AgentQueryOptions);
    const messages: AgentMessage[] = [];
    for await (const message of result.iterator) {
      messages.push(message);
    }
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'result', content: '⏹️ Codex turn interrupted',
    }));
    expect(messages.some((message) => message.content === '✅ Complete')).toBe(false);
    provider.dispose();
  });

  it('interrupts a turn when cancellation races its start acknowledgement', async () => {
    const { provider, dir } = providerFixture(`
read initialize; echo '{"id":1,"result":{}}'
read initialized
read thread; echo '{"id":2,"result":{"thread":{"id":"thread-1"}}}'
read start
marker_dir=${'${CODEX_HOME%/*}'}
echo started > "$marker_dir/start-seen"
sleep 0.1
echo '{"id":3,"result":{"turn":{"id":"turn-1"}}}'
read interrupt
echo "$interrupt" > "$marker_dir/interrupt-seen"
echo '{"id":4,"result":{}}'
`);
    const result = provider.queryStream((async function* () {
      yield { role: 'user', content: 'first' } as UserInput;
    })(), { sessionKey: 'chat-race', settingSources: [] } as AgentQueryOptions);
    const draining = (async () => {
      for await (const _message of result.iterator) { /* drain */ }
    })();
    await vi.waitFor(() => expect(() => readFileSync(join(dir, 'start-seen'), 'utf8')).not.toThrow());
    result.handle.cancel();
    await draining;
    await vi.waitFor(() => expect(() => readFileSync(join(dir, 'interrupt-seen'), 'utf8')).not.toThrow());
    expect(readFileSync(join(dir, 'interrupt-seen'), 'utf8')).toContain('turn/interrupt');
    provider.dispose();
  });
});
