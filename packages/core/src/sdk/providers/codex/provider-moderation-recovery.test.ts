import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage, UserInput } from '../../types.js';
import { CodexAgentProvider } from './provider.js';
import {
  readCodexContentModerationFailure,
  readCodexModerationRecoveryPolicy,
} from './moderation-recovery.js';

type Scenario = 'clean-success' | 'fallback-success' | 'repeat-stop' | 'unsafe' | 'rate-limit';
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
 else if(m.method==='model/list')send({id:m.id,result:{data:[{id:'gpt-6-luna',model:'gpt-6-luna',supportedReasoningEfforts:[{reasoningEffort:'low'}]},{id:'gpt-5.6-luna',model:'gpt-5.6-luna',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]}});
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
  const fail=()=>{const error={message:'upstream content moderation rejected the request [1301]',codexErrorInfo:'other'};
   send({method:'error',params:{threadId:m.params.threadId,turnId:'turn-'+attempt,error,willRetry:false}});
   send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'turn-'+attempt,status:'failed',error}}});};
  if(scenario==='unsafe'){send({method:'item/completed',params:{threadId:m.params.threadId,turnId:'turn-'+attempt,item:{id:'tool-'+attempt,type:'commandExecution',command:'owned effect',aggregated_output:'done',status:'completed'}}});fail();return;}
  const succeedBefore=scenario==='clean-success'?2:scenario==='fallback-success'?3:scenario==='rate-limit'?2:Infinity;
  if(attempt<succeedBefore)fail();
  else if(scenario==='rate-limit'&&attempt>2)fail();
  else send({method:'item/completed',params:{threadId:m.params.threadId,turnId:'turn-'+attempt,item:{id:'reply-'+attempt,type:'agentMessage',text:'moderation-recovered'}}}),
   send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'turn-'+attempt,status:'completed'}}});
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
      DISCLAUDE_CODEX_MODERATION_FALLBACK_MODELS: 'gpt-5.6-luna',
      DISCLAUDE_CODEX_MODERATION_MAX_PER_CHAT_PER_HOUR: scenario === 'rate-limit' ? '1' : '2',
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

describe('Codex content-moderation ladder (#5463)', () => {
  it('classifies [1301] as a distinct deterministic failure', () => {
    expect(readCodexContentModerationFailure({ message: 'upstream rejected [1301]' })?.code).toBe(
      '1301'
    );
    expect(
      readCodexContentModerationFailure({ message: 'Selected model is at capacity' })
    ).toBeUndefined();
    const policy = readCodexModerationRecoveryPolicy({
      DISCLAUDE_CODEX_MODERATION_FALLBACK_MODELS: 'a, a, b',
    });
    expect(policy.fallbackModels).toEqual(['a', 'b']);
    expect(policy.maxPerChatPerHour).toBe(2);
  });

  it('replays the original unmodified payload in a clean session and delivers normally', async () => {
    const original = '良性研究请求 [1301] context moderation 照常处理';
    const fx = fixture('clean-success');
    const messages = await collect(fx.query(fx.makeInput(original, 'm1')));
    expect(fx.attempts()).toBe(2);
    const [first, replay] = fx.runs();
    expect(first.input[0]?.text.startsWith(original)).toBe(true);
    expect(replay.input).toEqual(first.input);
    expect(replay.model).toBe('gpt-6-luna');
    expect(fx.threads().every((row) => row.startsWith('start '))).toBe(true);
    expect(messages.filter((m) => m.type === 'text').map((m) => m.content)).toEqual([
      'moderation-recovered',
    ]);
    expect(messages.some((m) => m.type === 'status' && m.content.includes('自动降级已完成'))).toBe(
      true
    );
    expect(messages.find((m) => m.type === 'result')?.metadata?.terminatedReason).toBeUndefined();
  });

  it('delivers normally when the configured fallback model accepts the original payload', async () => {
    const original = 'fallback must receive the complete original request';
    const fx = fixture('fallback-success');
    const messages = await collect(fx.query(fx.makeInput(original, 'm1b')));
    expect(fx.attempts()).toBe(3);
    expect(fx.runs().map((run) => run.model)).toEqual(['gpt-6-luna', 'gpt-6-luna', 'gpt-5.6-luna']);
    const [first, ...replays] = fx.runs();
    expect(first.input[0]?.text.startsWith(original)).toBe(true);
    for (const replay of replays) {
      expect(replay.input).toEqual(first.input);
    }
    expect(fx.threads().every((row) => row.startsWith('start '))).toBe(true);
    expect(messages.filter((m) => m.type === 'text').map((m) => m.content)).toEqual([
      'moderation-recovered',
    ]);
    expect(messages.find((m) => m.type === 'result')?.metadata?.terminatedReason).toBeUndefined();
  });

  it('moves to the configured fallback model, then stops immediately on a repeated verdict', async () => {
    const fx = fixture('repeat-stop');
    const messages = await collect(fx.query(fx.makeInput('still benign', 'm2')));
    expect(fx.attempts()).toBe(3);
    expect(fx.runs().map((run) => run.model)).toEqual(['gpt-6-luna', 'gpt-6-luna', 'gpt-5.6-luna']);
    const result = messages.find((m) => m.type === 'result');
    expect(result?.metadata?.terminatedReason).toBe('turn_failed');
    expect(result?.metadata?.terminationDetail).toContain('content moderation [1301]');
    expect(result?.metadata?.terminationDetail).toContain('diagnosticId=trace-5463:turn-3');
    expect(result?.content).toContain('诊断 ID');
    expect(result?.content).toContain('gpt-6-luna → gpt-5.6-luna');
    expect(result?.content).toContain('无需 /reset');
  });

  it('never replays a rejected turn that already performed work', async () => {
    const fx = fixture('unsafe');
    const messages = await collect(fx.query(fx.makeInput('side effect first', 'm3')));
    expect(fx.attempts()).toBe(1);
    expect(messages.find((m) => m.type === 'result')?.content).toContain(
      '自动重放可能重复外部副作用'
    );
  });

  it('bounds automatic recoveries per chat per hour', async () => {
    const fx = fixture('rate-limit');
    const messages = await collect(
      fx.query(fx.makeInput('first', 'm4a'), fx.makeInput('second', 'm4b'))
    );
    expect(fx.attempts()).toBe(3);
    const results = messages.filter((m) => m.type === 'result');
    expect(results).toHaveLength(2);
    expect(results[1]?.content).toContain('每小时自动降级次数已达上限 1');
  });
});
