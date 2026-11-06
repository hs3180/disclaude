import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage, UserInput } from '../../types.js';
import { CodexAgentProvider } from './provider.js';

/**
 * Issue #5463 (rework 2): an upstream content-review verdict ([1301]) is a
 * deterministic failure class — the codex provider must NOT replay the turn,
 * switch models, or wait in the overload backoff. The failed-turn terminal is
 * delivered once, with the [1301] text intact in content/terminationDetail so
 * the host (chat-agent.ts) renders the structured explanation card. Ordinary
 * throttle/overload failures keep the existing backoff-retry behavior.
 */
type Scenario = 'verdict' | 'verdict-overload-wording' | 'throttle-retry';
const owned: Array<{ provider: CodexAgentProvider; dir: string }> = [];

function fixture(scenario: Scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-moderation-5463-'));
  const home = join(dir, 'home'),
    bin = join(dir, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(home, 'auth.json'), '{}');
  const binary = join(bin, 'codex');
  writeFileSync(
    binary,
    `#!${process.execPath}
const fs=require('node:fs'),p=require('node:path'),scenario=${JSON.stringify(scenario)};
const file=name=>p.join(process.env.CODEX_HOME,name),send=m=>console.log(JSON.stringify(m));
const count=()=>fs.existsSync(file('attempts'))?Number(fs.readFileSync(file('attempts'),'utf8')):0;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),threadId='thread-'+Date.now();
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='model/list')send({id:m.id,result:{data:[{id:'gpt-6-luna',model:'gpt-6-luna',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]}});
 else if(m.method==='thread/start'){
  fs.appendFileSync(file('threads'),'start '+(m.params.model||'default')+'\\n');
  send({id:m.id,result:{thread:{id:threadId}}});
 }
 else if(m.method==='thread/resume'){
  fs.appendFileSync(file('threads'),'resume '+(m.params.model||'default')+'\\n');
  send({id:m.id,result:{thread:{id:m.params.threadId}}});
 }
 else if(m.method==='turn/start'){
  const attempt=count()+1;fs.writeFileSync(file('attempts'),String(attempt));
  fs.appendFileSync(file('runs'),JSON.stringify({model:m.params.model||'default',input:m.params.input,threadId:m.params.threadId})+'\\n');
  send({id:m.id,result:{turn:{id:'turn-'+attempt}}});
  const fail=()=>{const error={message:scenario==='verdict'?'upstream content moderation rejected the request [1301]':scenario==='verdict-overload-wording'?'HTTP 429 too many requests, and content moderation rejected the request [1301]':'HTTP 429 too many requests',codexErrorInfo:'other'};
   send({method:'error',params:{threadId:m.params.threadId,turnId:'turn-'+attempt,error,willRetry:false}});
   send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'turn-'+attempt,status:'failed',error}}});};
  if(scenario==='throttle-retry'&&attempt<2)fail();
  else if(scenario==='throttle-retry')send({method:'item/completed',params:{threadId:m.params.threadId,turnId:'turn-'+attempt,item:{id:'reply-'+attempt,type:'agentMessage',text:'throttle-recovered'}}}),
   send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'turn-'+attempt,status:'completed'}}});
  else fail();
 }
 else if(m.method==='turn/interrupt')send({id:m.id,result:{}});
});`
  );
  chmodSync(binary, 0o755);
  const provider = new CodexAgentProvider({
    transport: 'app-server',
    model: 'gpt-6-luna',
    reasoningEffort: 'low',
    builtinsDir: dir,
    env: {
      PATH: bin,
      CODEX_HOME: home,
      CODEX_REASONING_EFFORT: '',
    },
  });
  const resource = { provider, dir };
  owned.push(resource);
  const makeInput = (text: string, source: string): UserInput => ({
    role: 'user',
    content: text,
    correlation: {
      runId: 'run-5463',
      chatId: 'chat-5463',
      sourceMessageId: source,
      traceId: 'trace-5463',
    },
  });
  const query = (...inputs: UserInput[]) =>
    provider.queryStream(
      (async function* (): AsyncGenerator<UserInput> {
        for (const value of inputs) {
          yield value;
        }
      })(),
      { sessionKey: 'moderation-5463', settingSources: [] }
    );
  return {
    ...resource,
    query,
    makeInput,
    attempts: () => Number(readFileSync(join(home, 'attempts'), 'utf8')),
    runs: () =>
      readFileSync(join(home, 'runs'), 'utf8')
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              model: string;
              input: Array<{ type: string; text: string }>;
              threadId: string;
            }
        ),
    threads: () => readFileSync(join(home, 'threads'), 'utf8').trim().split('\n'),
  };
}
async function collect(result: ReturnType<CodexAgentProvider['queryStream']>) {
  const messages: AgentMessage[] = [];
  for await (const message of result.iterator) {
    messages.push(message);
  }
  return messages;
}
afterEach(() => {
  for (const resource of owned.splice(0)) {
    resource.provider.dispose();
    rmSync(resource.dir, { recursive: true, force: true });
  }
});

describe('Codex content-moderation verdict (#5463 rework 2)', () => {
  it('delivers the [1301] verdict exactly once — no replay, no fallback model, no backoff wait', async () => {
    const original = '良性研究请求 [1301] context moderation 照常处理';
    const fx = fixture('verdict');
    const messages = await collect(fx.query(fx.makeInput(original, 'm1')));

    // One and only one attempt: the verdict is deterministic, so the provider
    // never replays the input (clean session or otherwise) and never waits.
    expect(fx.attempts()).toBe(1);
    expect(fx.threads()).toEqual(['start gpt-6-luna']);
    const [run] = fx.runs();
    expect(run.model).toBe('gpt-6-luna');
    expect(run.input[0]?.text.startsWith(original)).toBe(true);

    const result = messages.find((message) => message.type === 'result');
    expect(result?.metadata?.terminatedReason).toBe('turn_failed');
    // The signature survives into the text channels the host classifies on.
    expect(result?.content).toContain('[1301]');
    expect(result?.metadata?.terminationDetail).toContain('[1301]');
    // No recovery narration of any kind (the one status message in this flow
    // is the provider's regular empty pre-turn status, not moderation text).
    expect(messages.every((message) => !message.content || !(message.content.includes('自动降级') || message.content.includes('重放') || message.content.includes('🛡️')))).toBe(true);
  });

  it('classifies moderation ahead of overload wording, so a [1301] verdict with 429 text still never retries', async () => {
    const fx = fixture('verdict-overload-wording');
    const messages = await collect(fx.query(fx.makeInput('benign but flagged', 'm2')));
    expect(fx.attempts()).toBe(1);
    const result = messages.find((message) => message.type === 'result');
    expect(result?.metadata?.terminatedReason).toBe('turn_failed');
    expect(result?.content).toContain('[1301]');
  });

  it('keeps the existing backoff retry for ordinary throttle failures (no moderation signature)', async () => {
    const fx = fixture('throttle-retry');
    const messages = await collect(fx.query(fx.makeInput('plain throttle', 'm3')));
    // The 429 failure is transient: the provider waits and retries once, then
    // delivers normally — the non-moderation failure path is unchanged.
    expect(fx.attempts()).toBe(2);
    expect(messages.filter((message) => message.type === 'text').map((message) => message.content)).toEqual([
      'throttle-recovered',
    ]);
    expect(messages.find((message) => message.type === 'result')?.metadata?.terminatedReason).toBeUndefined();
  }, 20_000);
});
