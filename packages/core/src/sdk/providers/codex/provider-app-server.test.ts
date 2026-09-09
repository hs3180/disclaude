import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
echo '{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","item":{"id":"item-1","type":"agentMessage","text":"hello"}}}'
read steer; echo '{"id":4,"result":{"turnId":"turn-1"}}'
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
    await vi.waitFor(() => expect(messages.some((message) => message.content === 'hello')).toBe(true));
    await expect(result.handle.steer?.('correction')).resolves.toEqual({ turnId: 'turn-1' });
    await vi.waitFor(() => expect(messages.some((message) => message.type === 'result')).toBe(true));
    releaseInput();
    await collecting;
    expect(result.handle.sessionId).toBe('thread-1');
    provider.dispose();
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
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'error' });
    expect(messages[0]?.content).toContain('exited (code=7');
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
});
