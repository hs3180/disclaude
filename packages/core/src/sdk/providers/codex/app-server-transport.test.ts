import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerTransport } from './app-server-transport.js';
import type { AgentInputRequest } from '../../user-input.js';

const resourceLog = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/logger.js', () => ({ createLogger: (_context: string, bindings: Record<string, unknown>) => ({
  info: (fields: Record<string, unknown>, message: string) => resourceLog({ ...bindings, ...fields }, message), warn: vi.fn(), debug: vi.fn(),
}) }));

const dirs: string[] = [];

function fixture(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-app-server-'));
  dirs.push(dir);
  const binary = join(dir, 'codex');
  writeFileSync(binary, `#!/bin/sh\n${body}`);
  chmodSync(binary, 0o755);
  return binary;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('CodexAppServerTransport', () => {
  const inputParams = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', isBlocking: true,
    questions: [{ id: 'browser', header: 'Browser', question: 'Which browser?', options: [{ label: 'Chromium', description: 'Dedicated profile' }] },
      { id: 'note', header: 'Note', question: 'Any constraints?', isOther: true }] };
  function inputFixture(body: string): string {
    const binary = fixture('');
    writeFileSync(binary, `#!${process.execPath}\nimport {createInterface} from 'node:readline';\nconst send=m=>process.stdout.write(JSON.stringify(m)+'\\n');\nconst params=${JSON.stringify(inputParams)};\n${body}`);
    return binary;
  }
  it('answers a string-ID multi-question server request once, without starting another turn', async () => {
    const binary = inputFixture(`
let starts=0;
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='turn/start'){starts++;send({id:m.id,result:{turn:{id:'turn-1'}}});send({id:'input-1',method:'item/tool/requestUserInput',params});}
 else if(m.id==='input-1'){send({method:'fixture/answer',params:{...m,starts}});send({id:'input-1',method:'item/tool/requestUserInput',params});}
});`);
    let input: AgentInputRequest | undefined;
    const received = vi.fn();
    const onUserInput = vi.fn((request: AgentInputRequest) => { input = request; return Promise.resolve(); });
    const transport = new CodexAppServerTransport({ binary, onUserInput, onNotification: received });
    try {
      await transport.request('turn/start');
      await vi.waitFor(() => expect(input).toBeDefined());
      await expect(input!.respond({ browser: { answers: ['unsupported'] }, note: { answers: ['No extensions'] } })).rejects.toThrow('offered option');
      const answers = { browser: { answers: ['Chromium'] }, note: { answers: ['No extensions'] } };
      await input!.respond(answers);
      await expect(input!.respond(answers)).rejects.toThrow('no longer active');
      await vi.waitFor(() => expect(received).toHaveBeenCalledWith('fixture/answer', expect.objectContaining({ id: 'input-1', starts: 1, result: { answers } })));
      expect(onUserInput).toHaveBeenCalledTimes(1);
    } finally { await transport.close(); }
  });
  it.each(['timeout', 'resolved', 'completed', 'interrupt', 'close'])('invalidates pending input on %s without inventing an answer', async reason => {
    const binary = inputFixture(`
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='begin'){send({id:m.id,result:{}});send({id:90,method:'item/tool/requestUserInput',params:{...params,isBlocking:false}});}
 else if(m.method==='invalidate'){
  send(${JSON.stringify(reason === 'resolved' ? { method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 90 } }
    : { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })});send({id:m.id,result:{}});
 } else if(m.id===90) send({method:'fixture/answer',params:m});
});`);
    let input: AgentInputRequest | undefined;
    const received = vi.fn();
    const transport = new CodexAppServerTransport({ binary, userInputTimeoutMs: reason === 'timeout' ? 120 : 10000,
      onUserInput: request => { input = request; return Promise.resolve(); }, onNotification: received });
    try {
      await transport.request('begin');
      await vi.waitFor(() => expect(input).toBeDefined());
      expect(input!.isBlocking).toBe(false);
      if (reason === 'close') { await transport.close(); }
      else if (reason === 'interrupt') { transport.cancelUserInputs('thread-1', 'turn-1'); }
      else if (reason !== 'timeout') { await transport.request('invalidate'); }
      await vi.waitFor(() => expect(input!.signal.aborted).toBe(true));
      await expect(input!.respond({ browser: { answers: ['Chromium'] }, note: { answers: ['none'] } })).rejects.toThrow('no longer active');
      expect(received.mock.calls.filter(([method, data]) => method === 'fixture/answer' && data.result)).toHaveLength(0);
    } finally { await transport.close(); }
  });
  it.each([false, true])('enables input only with a host handler and preserves browser isolation (input=%s)', async inputEnabled => {
    const binary = fixture(`printf '%s\\n' "$@" > "$(dirname "$0")/args"
printf '%s|%s' "$BU_CDP_URL" "$DISCLAUDE_BROWSER_SOCKET" > "$(dirname "$0")/cdp"
while read line; do :; done`);
    const transport = new CodexAppServerTransport({ binary, onUserInput: inputEnabled ? () => Promise.resolve() : undefined, env: { ...process.env, BU_CDP_URL: 'http://127.0.0.1:9222', DISCLAUDE_BROWSER_SOCKET: '/tmp/browser.sock' } });
    try {
      await vi.waitFor(() => expect(readFileSync(join(dirname(binary), 'cdp'), 'utf8').trim()).toBe('|/tmp/browser.sock'));
      expect(readFileSync(join(dirname(binary), 'args'), 'utf8').trim().split('\n')).toEqual([
        'app-server', '--stdio', '--disable', 'browser_use', '--disable', 'browser_use_external', '--disable', 'browser_use_full_cdp_access',
        ...(inputEnabled ? ['--enable', 'default_mode_request_user_input'] : []),
      ]);
    } finally { await transport.close(); }
  });

  it.each(['close', 'crash'])('reclaims a stubborn descendant after parent %s', async mode => {
    const binary = fixture(`
"${process.execPath}" -e 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)' </dev/null >/dev/null 2>&1 &
echo $! > "$(dirname "$0")/descendant"
read line
${mode === 'crash' ? 'exit 7' : 'while :; do sleep 1; done'}
`);
    const transport = new CodexAppServerTransport({ binary, killGraceMs: 50 });
    let pid: number | undefined;
    try {
      await vi.waitFor(() => {pid = Number(readFileSync(join(dirname(binary), 'descendant'), 'utf8')); expect(pid).toBeGreaterThan(0);});
      if (mode === 'crash') {await expect(transport.request('crash')).rejects.toThrow();}
      await transport.close();
      await vi.waitFor(() => expect(() => process.kill(pid as number, 0)).toThrow(), { timeout: 2000 });
    } finally {
      await transport.close();
      if (pid) {try {process.kill(pid, 'SIGKILL');} catch { /* already reaped */ }}
    }
  });

  it('initializes, correlates responses, and forwards notifications', async () => {
    const binary = fixture(`
read initialize
id=$(printf '%s' "$initialize" | sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p')
printf '{"jsonrpc":"2.0","id":%s,"result":{"serverInfo":{"name":"fixture"}}}\\n' "$id"
read initialized
printf '{"jsonrpc":"2.0","method":"thread/started","params":{"thread":{"id":"t-1"}}}\\n'
read request
id=$(printf '%s' "$request" | sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p')
printf '{"jsonrpc":"2.0","id":%s,"result":{"turnId":"turn-1"}}\\n' "$id"
`);
    const onNotification = vi.fn();
    const transport = new CodexAppServerTransport({ binary, onNotification, sessionKey: 'resource-session', correlation: { runId: 'app-run', chatId: 'app-chat', sourceMessageId: 'source-message', traceId: 'app-trace' } });
    try {
      await expect(transport.initialize()).resolves.toMatchObject({ serverInfo: { name: 'fixture' } });
      expect(resourceLog).toHaveBeenCalledWith(expect.objectContaining({ sessionKey: 'resource-session', runId: 'app-run', chatId: 'app-chat', sourceMessageId: 'source-message', traceId: 'app-trace', phase: 'initialized', available: true, processCount: expect.any(Number), rssKiB: expect.any(Number) }), 'Codex owned process resources');
      await expect(transport.request('turn/start', { threadId: 't-1', input: [] }))
        .resolves.toEqual({ turnId: 'turn-1' });
      await vi.waitFor(() => expect(onNotification).toHaveBeenCalledWith(
        'thread/started', { thread: { id: 't-1' } }
      ));
    } finally {
      await transport.close();
      expect(resourceLog).toHaveBeenCalledWith(expect.objectContaining({ sessionKey: 'resource-session', runId: 'app-run', chatId: 'app-chat', sourceMessageId: 'source-message', traceId: 'app-trace', phase: 'closed', available: true, processCount: 0 }), 'Codex owned process resources');
    }
  });

  it('rejects pending requests when the process exits', async () => {
    const transport = new CodexAppServerTransport({ binary: fixture('read line\nexit 7') });
    await expect(transport.request('thread/start', {})).rejects.toThrow(/exited.*code=7/);
  });

  it('fails closed for server approval/tool requests', async () => {
    const binary = fixture(`
read request
printf '{"jsonrpc":"2.0","id":99,"method":"item/commandExecution/requestApproval","params":{}}\\n'
read response
printf '%s' "$response" > "$(dirname "$0")/response"
`);
    const transport = new CodexAppServerTransport({ binary });
    await expect(transport.request('will-remain-pending')).rejects.toThrow(/code=0/);
    expect(JSON.parse(readFileSync(join(dirname(binary), 'response'), 'utf8'))).toMatchObject({
      id: 99,
      error: { code: -32601 },
    });
  });

  it('times out a silent request and clears it without killing the transport', async () => {
    const transport = new CodexAppServerTransport({
      binary: fixture('read line\nwhile :; do sleep 1; done'),
      requestTimeoutMs: 25,
    });
    await expect(transport.request('thread/start', {})).rejects.toThrow(/timed out: thread\/start/);
    await transport.close();
  });

  it('drains bounded stderr and escalates a stubborn child to SIGKILL', async () => {
    const transport = new CodexAppServerTransport({
      binary: fixture(`
trap '' TERM
printf '%09000d' 0 >&2
while :; do sleep 1; done
`),
      killGraceMs: 25,
    });
    await vi.waitFor(() => expect(transport.getStderrTail().length).toBe(8192));
    const exit = await transport.close();
    expect(exit.signal).toBe('SIGKILL');
    expect(exit.stderrTail).toHaveLength(8192);
  });

  it('ignores valid non-object JSON without crashing request correlation', async () => {
    const binary = fixture(`
read request
printf 'null\\n[]\\n'
id=$(printf '%s' "$request" | sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p')
printf '{"id":%s,"result":"ok"}\\n' "$id"
`);
    const transport = new CodexAppServerTransport({ binary });
    await expect(transport.request('thread/read', {})).resolves.toBe('ok');
  });

  it('still kills a stubborn child after stdin EPIPE closes the protocol', async () => {
    const ready = vi.fn();
    const transport = new CodexAppServerTransport({
      binary: fixture(`
exec 0<&-
printf '{"method":"fixture/ready"}\\n'
trap '' TERM
while :; do sleep 1; done
`),
      onNotification: ready,
      killGraceMs: 25,
    });
    await vi.waitFor(() => expect(ready).toHaveBeenCalled());
    await expect(transport.request('thread/start', {})).rejects.toThrow();
    await expect(transport.close()).resolves.toMatchObject({ signal: 'SIGKILL' });
  });

  it('contains a throwing notification consumer and closes the child', async () => {
    const transport = new CodexAppServerTransport({
      binary: fixture(`
read request
printf '{"method":"thread/started","params":{}}\\n'
while :; do sleep 1; done
`),
      onNotification: () => {
        throw new Error('consumer failed');
      },
      killGraceMs: 25,
    });
    await expect(transport.request('thread/read', {})).rejects.toThrow('consumer failed');
    await expect(transport.close()).resolves.toMatchObject({ signal: 'SIGTERM' });
  });
});
