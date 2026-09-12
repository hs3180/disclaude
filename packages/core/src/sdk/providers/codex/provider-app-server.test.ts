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
  it('uses the same registry manifest as exec for app-server turns', async () => {
    const { provider, dir } = providerFixture('exit 0');
    const workspace = mkdtempSync(join(tmpdir(), 'codex-app-skills-'));
    dirs.push(workspace);
    mkdirSync(join(workspace, 'skills', 'demo'), { recursive: true });
    writeFileSync(join(workspace, 'skills', 'demo', 'SKILL.md'), '---\ndescription: Demo skill\n---');
    writeFileSync(join(dir, 'bin', 'codex'), `#!${process.execPath}
const fs = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); if (!request.id) return;
  let result = {}; if (request.method === 'thread/start') result = {thread:{id:'skills-thread'}};
  if (request.method === 'turn/start') { fs.writeFileSync(process.env.CODEX_HOME + '/turn-input', request.params.input[0].text); result={turn:{id:'skills-turn'}}; }
  console.log(JSON.stringify({id:request.id,result}));
  if (request.method === 'turn/start') console.log(JSON.stringify({method:'turn/completed',params:{threadId:'skills-thread',turn:{id:'skills-turn',status:'completed'}}}));
});`);
    const stream = provider.queryStream((async function* () { yield { role: 'user', content: 'hello' } as UserInput; })(), {
      sessionKey: 'skills', cwd: workspace, settingSources: [],
    } as AgentQueryOptions);
    for await (const _message of stream.iterator) { /* drain */ }
    const prompt = readFileSync(join(dir, 'home', 'turn-input'), 'utf8');
    expect(prompt).toContain('Disclaude skills:');
    expect(prompt).toContain('skills/demo/SKILL.md');
    expect(prompt).toContain('User request:\nhello');
    expect(prompt).not.toContain(workspace);
    provider.dispose();
  });

  it('reclaims tool children over 100 turns while resuming one thread', async () => {
    const { provider, dir } = providerFixture('exit 0');
    const binary = join(dir, 'bin', 'codex');
    writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const home = process.env.CODEX_HOME;
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (!request.id) return;
  fs.appendFileSync(home + '/methods', request.method + '\\n');
  let result = {};
  if (request.method === 'thread/start' || request.method === 'thread/resume') {
    result = { thread: { id: 'retained-thread' } };
    if (request.method === 'thread/resume' && request.params.threadId !== 'retained-thread') process.exit(9);
  }
  if (request.method === 'turn/start') {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    fs.appendFileSync(home + '/children', child.pid + '\\n');
    result = { turn: { id: 'turn' } };
  }
  console.log(JSON.stringify({ id: request.id, result }));
  if (request.method === 'turn/start') {
    console.log(JSON.stringify({ method: 'item/completed', params: {threadId:'retained-thread',turnId:'turn',item:{id:'reply',type:'agentMessage',text:'context retained'}} }));
    console.log(JSON.stringify({ method: 'turn/completed', params: {threadId:'retained-thread',turn:{id:'turn',status:'completed'}} }));
  }
});
`);
    const seen: number[] = [];
    const input = (async function* () {
      for (let turn = 0; turn < 100; turn++) {
        if (turn) {
          const pids = readFileSync(join(dir, 'home', 'children'), 'utf8').trim().split('\n').map(Number);
          for (const pid of pids) {expect(() => process.kill(pid, 0)).toThrow();}
          seen.push(pids.length);
        }
        yield { role: 'user', content: `turn ${turn}` } as UserInput;
      }
    })();
    const stream = provider.queryStream(input, { sessionKey: 'stress', settingSources: [] } as AgentQueryOptions);
    const messages: AgentMessage[] = [];
    try {
      for await (const message of stream.iterator) {messages.push(message);}
      expect(messages.filter(message => message.type === 'text')).toHaveLength(100);
      expect(messages.filter(message => message.type === 'error')).toEqual([]);
      expect(seen).toHaveLength(99);
      const methods = readFileSync(join(dir, 'home', 'methods'), 'utf8').trim().split('\n');
      expect(methods.filter(method => method === 'thread/start')).toHaveLength(1);
      expect(methods.filter(method => method === 'thread/resume')).toHaveLength(99);
      for (const pid of readFileSync(join(dir, 'home', 'children'), 'utf8').trim().split('\n').map(Number)) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally {provider.dispose();}
  }, 60000);

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
    let releaseInput!: () => void;
    const inputReleased = new Promise<void>(resolve => {releaseInput = resolve;});
    const result = provider.queryStream((async function* () {
      yield { role: 'user', content: 'first' } as UserInput;
      await inputReleased;
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
      type: 'status', content: '', metadata: expect.objectContaining({ messageId: 'turn-1' }),
    })));
    await expect(result.handle.steer?.('correction')).resolves.toEqual({ turnId: 'turn-1' });
    await vi.waitFor(() => expect(messages.some((message) => message.type === 'result')).toBe(true));
    releaseInput();
    await collecting;
    expect(messages).toContainEqual(expect.objectContaining({ type: 'text', content: 'hello' }));
    expect(messages.some(message => message.content === 'Codex turn started')).toBe(false);
    expect(result.handle.sessionId).toBe('thread-1');
    provider.dispose();
  });

  it('waits for cancellation completion before an immediate same-thread follow-up', async () => {
    const { provider } = providerFixture(`
if [ -f "$CODEX_HOME/first-finished" ]; then
  read initialize; echo '{"id":1,"result":{}}'
  read initialized
  read resume; printf '%s' "$resume" > "$CODEX_HOME/resume"
  echo '{"id":2,"result":{"thread":{"id":"thread-1"}}}'
  read start; echo '{"id":3,"result":{"turn":{"id":"turn-2"}}}'
  echo '{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-2","item":{"id":"reply","type":"agentMessage","text":"resumed"}}}'
  echo '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-2","status":"completed"}}}'
  exit 0
fi

read initialize; echo '{"id":1,"result":{}}'
read initialized
read thread; echo '{"id":2,"result":{"thread":{"id":"thread-1"}}}'
read start; echo '{"id":3,"result":{"turn":{"id":"turn-1"}}}'
read interrupt; echo '{"id":4,"error":{"code":-32600,"message":"no active turn to interrupt"}}'
/bin/sleep 0.05
/usr/bin/touch "$CODEX_HOME/first-finished"
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

  it('forgets an idle input stream without letting it resurrect a native thread', async () => {
    const { provider } = providerFixture('exit 0');
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const stream = provider.queryStream((async function* () {
      await gate;
      yield { role: 'user', content: 'must not execute after reset' } as UserInput;
    })(), { sessionKey: 'forgotten', settingSources: [] } as AgentQueryOptions);
    try {
      const collected = (async () => {const messages = []; for await (const message of stream.iterator) {messages.push(message);} return messages;})();
      provider.forgetSession('forgotten');
      await expect(collected).resolves.toEqual([]);
      release();
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(stream.handle.sessionId).toBeUndefined();
      expect(provider.getQuotaStats().turnsCompleted).toBe(0);
    } finally {release(); provider.dispose();}
  });

  it('keeps replacement teardown ownership when an older same-key stream finishes', async () => {
    const { provider } = providerFixture('exit 0');
    const releases: Array<() => void> = [];
    const waitingInput = () => (async function* () {
      await new Promise<void>(resolve => releases.push(resolve));
      yield { role: 'user', content: 'must not start' } as UserInput;
    })();
    const options = { sessionKey: 'replacement', settingSources: [] } as AgentQueryOptions;
    const first = provider.queryStream(waitingInput(), options);
    const second = provider.queryStream(waitingInput(), options);
    const drain = async (stream: typeof first) => {for await (const _message of stream.iterator) { /* drain */ }};
    try {
      await drain(first);
      provider.dispose();
      await drain(second);
    } finally {for (const release of releases) {release();} provider.dispose();}
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

describe('app-server session capacity regression', () => {
  function controlledProvider() {
    const fixture = providerFixture('exit 0');
    writeFileSync(join(fixture.dir, 'bin', 'codex'), `#!${process.execPath}
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (!request.id) return;
  const threadId = request.params?.threadId || 'thread-' + process.pid;
  let result = {};
  if (request.method === 'thread/start' || request.method === 'thread/resume') result = { thread: { id: threadId } };
  if (request.method === 'turn/start') result = { turn: { id: 'turn-1' } };
  if (request.method === 'turn/steer') result = { turnId: 'turn-1' };
  console.log(JSON.stringify({ id: request.id, result }));
  if (request.method === 'turn/steer') console.log(JSON.stringify({method:'turn/completed',params:{threadId,turn:{id:'turn-1',status:'completed'}}}));
});
`);
    return fixture.provider;
  }

  function start(provider: CodexAgentProvider, sessionKey: string) {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const result = provider.queryStream((async function* () {
      yield { role: 'user', content: 'hold until steer' } as UserInput;
      await pending;
    })(), { sessionKey, settingSources: [] } as AgentQueryOptions);
    const messages: AgentMessage[] = [];
    const collecting = (async () => {
      for await (const message of result.iterator) {messages.push(message);}
    })();
    return { ...result, messages, collecting, release };
  }
  type Stream = ReturnType<typeof start>;
  const started = (stream: Stream) => vi.waitFor(() => expect(stream.messages.some(m => m.type === 'status')).toBe(true));
  const complete = async (stream: Stream) => {
    await stream.handle.steer?.('finish');
    await vi.waitFor(() => expect(stream.messages.some(m => m.content === '✅ Complete')).toBe(true));
  };

  it('protects the older running turn, silently evicts idle, and resumes its thread', async () => {
    const provider = controlledProvider();
    provider.setGovernanceLimits({ maxActiveSessions: 2, maxConcurrentRuns: 2 });
    const streams: Stream[] = [];
    try {
      const active = start(provider, 'active'); streams.push(active);
      await started(active);
      const idle = start(provider, 'idle'); streams.push(idle);
      await started(idle);
      await complete(idle);
      await vi.waitFor(() => expect(provider.getGovernanceStats().runningRuns).toBe(1));
      const threadId = idle.handle.sessionId;
      const newcomer = start(provider, 'new'); streams.push(newcomer);
      await started(newcomer);
      await idle.collecting;
      expect(idle.messages.filter(m => m.type === 'error')).toEqual([]);
      expect(idle.messages.filter(m => m.metadata?.terminatedReason === 'evicted')).toEqual([
        { type: 'result', content: '', role: 'system', metadata: { terminatedReason: 'evicted' } },
      ]);
      expect(active.messages.some(m => m.type === 'result' || m.type === 'error')).toBe(false);
      await complete(active);
      await complete(newcomer);
      await vi.waitFor(() => expect(provider.getGovernanceStats().runningRuns).toBe(0));
      const resumed = start(provider, 'idle'); streams.push(resumed);
      await started(resumed);
      expect(resumed.handle.sessionId).toBe(threadId);
      expect(provider.getGovernanceStats().activeSessions).toBe(2);
    } finally {
      provider.dispose();
      for (const stream of streams) {stream.release();}
      await Promise.all(streams.map(s => s.collecting));
    }
    expect(provider.getGovernanceStats().activeSessions).toBe(0);
  });

  it('queues at an all-busy cap and removes cancelled admission without spawning a turn', async () => {
    const provider = controlledProvider();
    provider.setGovernanceLimits({ maxActiveSessions: 1, maxConcurrentRuns: 1 });
    const streams: Stream[] = [];
    try {
      const active = start(provider, 'active'); streams.push(active);
      await started(active);
      const cancelled = start(provider, 'cancelled'); streams.push(cancelled);
      const waiting = start(provider, 'waiting'); streams.push(waiting);
      // Let the input generators reach admission before cancelling.
      await new Promise(resolve => setImmediate(resolve));
      expect(provider.getGovernanceStats().activeSessions).toBe(1);
      expect(provider.getGovernanceStats().evictedSessions).toBe(0);
      cancelled.handle.cancel();
      await cancelled.collecting;
      expect(cancelled.messages).toEqual([]);
      expect(waiting.messages).toEqual([]);
      await complete(active);
      await started(waiting);
      await active.collecting;
      expect(active.messages.some(m => m.metadata?.terminatedReason === 'evicted')).toBe(true);
      expect(provider.getGovernanceStats().runningRuns).toBe(1);
      await complete(waiting);
    } finally {
      provider.dispose();
      for (const stream of streams) {stream.release();}
      await Promise.all(streams.map(s => s.collecting));
    }
    expect(provider.getGovernanceStats().activeSessions).toBe(0);
  });
});
