import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentQueryOptions, UserInput } from '../../types.js';
import { CodexAgentProvider } from './provider.js';

type Transport = 'exec' | 'app-server';
interface Scenario {
  failures: number;
  prefix?: 'text' | 'command' | 'unknown' | 'plan' | 'diagnostic';
  error?: { message: string; codexErrorInfo: string };
  retryAfter?: string;
  special?: 'host-tool' | 'question' | 'async-question' | 'steer' | 'missing-terminal';
  lateProgress?: boolean;
  internallyRecovered?: boolean;
}
const owned: Array<{ provider: CodexAgentProvider; dir: string }> = [];
/** #5468: fast capacity-continuation waits (app-server post-progress tests). */
const CAPACITY_FAST = {
  DISCLAUDE_CODEX_CAPACITY_RECOVERY_INITIAL_DELAY_MS: '40',
  DISCLAUDE_CODEX_CAPACITY_RECOVERY_MAX_DELAY_MS: '40',
};

function fixture(transport: Transport, scenario: Scenario, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-overload-064-'));
  const home = join(dir, 'home'), bin = join(dir, 'bin');
  mkdirSync(home); mkdirSync(bin);
  writeFileSync(join(home, 'auth.json'), '{}');
  const binary = join(bin, 'codex');
  writeFileSync(binary, `#!${process.execPath}
const fs=require('node:fs'),p=require('node:path'),scenario=${JSON.stringify(scenario)},transport=${JSON.stringify(transport)};
const file=name=>p.join(process.env.CODEX_HOME,name),send=m=>console.log(JSON.stringify(m));let currentTurn;
function run(turnId) {
 const count=fs.existsSync(file('attempts'))?Number(fs.readFileSync(file('attempts'),'utf8'))+1:1;
 fs.writeFileSync(file('attempts'),String(count));fs.appendFileSync(file('times'),String(Date.now())+'\\n');
 const threadId='owned-overload-thread';
 const event=(phase,item)=>transport==='exec'?send({type:'item.'+phase,item}):send({method:'item/'+phase,params:{threadId,turnId,item}});
 const complete=()=>{event('completed',{id:'reply',type:transport==='exec'?'agent_message':'agentMessage',text:'overload-recovered'});if(transport==='exec')send({type:'turn.completed'});else send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});};
 if(transport==='exec'){send({type:'thread.started',thread_id:threadId});send({type:'turn.started'});}
 if(scenario.internallyRecovered){const message='server_overloaded: model at capacity';if(transport==='exec')send({type:'error',message});else send({method:'error',params:{threadId,turnId,error:{message,codexErrorInfo:'serverOverloaded'},willRetry:true}});complete();return;}
 if(count<=scenario.failures) {
  if(scenario.prefix==='diagnostic')send({type:'error',message:'Visible diagnostic before failure'});
  if(scenario.prefix==='text')event('completed',{id:'prefix',type:transport==='exec'?'agent_message':'agentMessage',text:'Already visible'});
  if(scenario.prefix==='command'||scenario.prefix==='unknown'||scenario.prefix==='plan') {
   fs.appendFileSync(file('effects'),'effect\\n');
   const item={id:'side-effect',type:scenario.prefix==='unknown'?'futureExternalAction':scenario.prefix==='plan'?transport==='exec'?'todo_list':'plan':transport==='exec'?'command_execution':'commandExecution',command:'owned effect',aggregated_output:'done',status:'completed'};
   event('started',item);event('completed',item);
  }
  const error={message:'server_overloaded: Selected model is at capacity. Please try a different model.',codexErrorInfo:'serverOverloaded',...scenario.error,...(scenario.retryAfter?{additionalDetails:'Retry-After: '+scenario.retryAfter}:{})};
  if(scenario.special==='missing-terminal'){console.error(error.message);process.exit(1);return;}
  const terminal=transport==='exec'?{type:'turn.failed',error}:{method:'turn/completed',params:{threadId,turn:{id:turnId,status:'failed',error}}};
  if(transport==='app-server')send({method:'error',params:{threadId,turnId,error,willRetry:false}});
  if(scenario.lateProgress) {
   fs.appendFileSync(file('effects'),'effect\\n');
   const item={id:'late-effect',type:'futureExternalAction'};
   const packets=[terminal,...['started','completed'].map(phase=>transport==='exec'?{type:'item.'+phase,item}:{method:'item/'+phase,params:{threadId,turnId,item}})];
   process.stdout.write(packets.map(JSON.stringify).join('\\n')+'\\n');
  } else send(terminal);
  if(transport==='exec')process.exitCode=1;
 } else complete();
}
if(transport==='exec')run('owned-exec-turn');
else require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='model/list')send({id:m.id,result:{data:[{id:'gpt-6-luna',model:'gpt-6-luna',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]}});
 else if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:'owned-overload-thread'}}});
 else if(m.method==='turn/start'){
  currentTurn='owned-turn-'+Date.now();
  fs.appendFileSync(file('inputs'),JSON.stringify(m.params.input)+'\\n===END===\\n');
  send({id:m.id,result:{turn:{id:currentTurn}}});
  // #5468: specials belong to the first attempt only — a capacity
  // continuation turn must run to its own outcome.
  const first=!fs.existsSync(file('attempts'));
  if(scenario.special==='host-tool'&&first)send({id:'owned-host',method:'item/tool/call',params:{callId:'owned-host-call',threadId:'owned-overload-thread',turnId:currentTurn,namespace:'disclaude',tool:'owned_effect',arguments:{}}});
  else if(scenario.special==='question'&&first)send({id:'owned-question',method:'item/tool/requestUserInput',params:{threadId:'owned-overload-thread',turnId:currentTurn,itemId:'owned-input-item',isBlocking:true,questions:[{id:'choice',header:'Choice',question:'Which?',options:[{label:'Alpha',description:'Owned choice'}]}]}});
  else if(scenario.special==='async-question'&&first){
   send({method:'item/completed',params:{threadId:'owned-overload-thread',turnId:currentTurn,item:{id:'owned-async-question',type:'agentMessage',text:'Which scope?',delivery:'async',questions:[{title:'Which scope?'}]}}});
   setTimeout(()=>run(currentTurn),150);
  }
  else if(scenario.special==='steer'&&first)setTimeout(()=>run(currentTurn),200);
  else run(currentTurn);
 }
 else if(m.id==='owned-host'||m.id==='owned-question')run(currentTurn);
 else if(m.method==='turn/steer')send({id:m.id,result:{turnId:currentTurn}});
 else if(m.method==='turn/interrupt')send({id:m.id,result:{}});
});
`);
  chmodSync(binary, 0o755);
  const provider = new CodexAgentProvider({ transport, model: 'gpt-6-luna', reasoningEffort: 'low', builtinsDir: dir,
    env: { PATH: bin, CODEX_HOME: home, CODEX_REASONING_EFFORT: '', ...extraEnv } });
  const resource = { provider, dir }; owned.push(resource);
  const query = (extra: Partial<AgentQueryOptions> = {}, extraInput: Partial<UserInput> = {}) => provider.queryStream((async function* (): AsyncGenerator<UserInput> {
    yield { role: 'user', content: 'Complete the owned task', correlation: { runId: 'owned-run', chatId: 'owned-chat', sourceMessageId: 'owned-overload-source', traceId: 'owned-trace' }, ...extraInput };
  })(), { sessionKey: 'owned-overload', settingSources: [], ...extra });
  return { ...resource, query, attempts: () => Number(readFileSync(join(home, 'attempts'), 'utf8')),
    effects: () => readFileSync(join(home, 'effects'), 'utf8').trim().split('\n'),
    inputs: () => readFileSync(join(home, 'inputs'), 'utf8').trim().split('\n===END===\n'),
    times: () => readFileSync(join(home, 'times'), 'utf8').trim().split('\n').map(Number) };
}
async function collect(result: ReturnType<CodexAgentProvider['queryStream']>) {
  const messages: AgentMessage[] = [];
  for await (const message of result.iterator) { messages.push(message); }
  return messages;
}
afterEach(() => {
  for (const resource of owned.splice(0)) { resource.provider.dispose(); rmSync(resource.dir, { recursive: true, force: true }); }
});

describe.each<Transport>(['exec', 'app-server'])('Codex %s safe overload retry (#5269)', transport => {
  it('recovers before output or tools and delivers only one successful result', async () => {
    const fx = fixture(transport, { failures: 1 });
    const messages = await collect(fx.query());
    expect(fx.attempts()).toBe(2);
    expect(messages.filter(m => m.type === 'text').map(m => m.content)).toEqual(['overload-recovered']);
    expect(messages.filter(m => m.type === 'result')).toHaveLength(1);
    expect(messages.some(m => m.type === 'error' || m.metadata?.terminatedReason === 'turn_failed')).toBe(false);
  });

  it('reports one terminal failure with the upstream cause after the bounded retry budget', async () => {
    const fx = fixture(transport, { failures: 10 });
    const messages = await collect(fx.query());
    expect(fx.attempts()).toBe(3);
    expect(messages.filter(m => m.type === 'result')).toHaveLength(1);
    expect(messages.find(m => m.type === 'result')?.metadata?.terminatedReason).toBe('turn_failed');
    expect(messages.map(m => m.content).join('\n')).toContain('Selected model is at capacity');
  });

  it.each([
    { codexErrorInfo: 'unauthorized', message: '401 Unauthorized: server_overloaded is not the cause' },
    { codexErrorInfo: 'badRequest', message: 'Invalid configuration; server_overloaded retry is inappropriate' },
    { codexErrorInfo: 'sandboxError', message: 'Permission denied' },
    { codexErrorInfo: 'usageLimitExceeded', message: 'Usage limit reached' },
  ])('does not retry $codexErrorInfo', async error => {
    const fx = fixture(transport, { failures: 10, error });
    const messages = await collect(fx.query());
    expect(fx.attempts()).toBe(1);
    expect(messages.filter(m => m.type === 'result')).toHaveLength(1);
  });

  it.each(['text', 'command', 'unknown'] as const)('does not replay after %s progress', async prefix => {
    const fx = fixture(transport, { failures: 1, prefix }, transport === 'app-server' ? CAPACITY_FAST : {});
    const messages = await collect(fx.query());
    if (prefix !== 'text') { expect(fx.effects()).toHaveLength(1); }
    if (transport === 'app-server') {
      // #5468: explicit capacity after progress continues the SAME thread
      // with a recovery instruction — never a replay of the original input.
      expect(fx.attempts()).toBe(2);
      expect(fx.inputs()).toHaveLength(2);
      expect(fx.inputs()[1]).toContain('上一回合因模型容量暂时不足而中止');
      expect(fx.inputs().filter(text => text.includes('Complete the owned task'))).toHaveLength(1);
      expect(messages.filter(m => m.type === 'result')).toHaveLength(1);
      expect(messages.some(m => m.metadata?.terminatedReason === 'turn_failed')).toBe(false);
    } else {
      expect(fx.attempts()).toBe(1);
      expect(messages.some(m => m.metadata?.terminatedReason === 'turn_failed')).toBe(true);
    }
  });

  it('waits at least the supplied Retry-After before retrying', async () => {
    const fx = fixture(transport, { failures: 1, retryAfter: '1' });
    await collect(fx.query());
    expect(fx.attempts()).toBe(2);
    expect(fx.times()[1]! - fx.times()[0]!).toBeGreaterThanOrEqual(980);
  });

  it('declines a Retry-After beyond the total wait budget rather than retrying early', async () => {
    const fx = fixture(transport, { failures: 1, retryAfter: '3600' });
    const messages = await collect(fx.query());
    expect(fx.attempts()).toBe(1);
    expect(messages.some(m => m.metadata?.terminatedReason === 'turn_failed')).toBe(true);
  });

  it('cancels the backoff without spawning another attempt', async () => {
    const fx = fixture(transport, { failures: 1 });
    const result = fx.query();
    let sawRetry = false;
    for await (const message of result.iterator) {
      if (message.type === 'status' && message.content.includes('过载')) { sawRetry = true; result.handle.cancel(); }
    }
    expect(sawRetry).toBe(true);
    await vi.waitFor(() => expect(fx.provider.getGovernanceStats().runningRuns).toBe(0));
    expect(fx.attempts()).toBe(1);
  });

  it('does not replay a transport exit with no confirmed turn failure', async () => {
    const fx = fixture(transport, { failures: 1, special: 'missing-terminal' });
    const messages = await collect(fx.query());
    expect(fx.attempts()).toBe(1);
    expect(messages.some(m => m.type === 'status' && m.content.includes('过载'))).toBe(false);
  });

  it('does not replay after work reported just after the terminal in the same input batch', async () => {
    const fx = fixture(transport, { failures: 1, lateProgress: true }, transport === 'app-server' ? CAPACITY_FAST : {});
    const messages = await collect(fx.query());
    expect(fx.effects()).toHaveLength(1);
    if (transport === 'app-server') {
      // #5468: late-reported work counts as progress; the thread continues.
      expect(fx.attempts()).toBe(2);
      expect(messages.some(m => m.metadata?.terminatedReason === 'turn_failed')).toBe(false);
    } else {
      expect(fx.attempts()).toBe(1);
      expect(messages.some(m => m.metadata?.terminatedReason === 'turn_failed')).toBe(true);
    }
  });

  it('lets Codex complete its own retry without starting an outer retry', async () => {
    const fx = fixture(transport, { failures: 1, internallyRecovered: true });
    const messages = await collect(fx.query());
    expect(fx.attempts()).toBe(1);
    expect(messages.filter(m => m.type === 'result')).toHaveLength(1);
    expect(messages.some(m => m.type === 'error' || m.metadata?.terminatedReason === 'turn_failed')).toBe(false);
  });
});

describe('Codex overload preserves host-side input and effects', () => {
  it.each(['plan', 'diagnostic'] as const)('does not replay an exec turn after %s progress', async prefix => {
    const fx = fixture('exec', { failures: 10, prefix });
    const messages = await collect(fx.query());
    expect(fx.attempts()).toBe(1);
    if (prefix === 'plan') { expect(fx.effects()).toHaveLength(1); }
    expect(messages.some(m => m.metadata?.terminatedReason === 'turn_failed')).toBe(true);
  });

  it('continues the thread after a host tool without replaying the host input', async () => {
    const fx = fixture('app-server', { failures: 1, special: 'host-tool' }, CAPACITY_FAST);
    const execute = vi.fn(() => Promise.resolve({ performed: true }));
    const messages = await collect(fx.query({ tools: [{ name: 'owned_effect', description: 'Owned effect', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, execute }] }));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fx.attempts()).toBe(2);
    expect(messages.some(m => m.metadata?.terminatedReason === 'turn_failed')).toBe(false);
  });

  it('does not repeat a native question already delivered to its host', async () => {
    const fx = fixture('app-server', { failures: 1, special: 'question' }, CAPACITY_FAST);
    const onUserInput = vi.fn(async request => { await request.respond({ choice: { answers: ['Alpha'] } }); });
    const messages = await collect(fx.query({ onUserInput }));
    expect(onUserInput).toHaveBeenCalledTimes(1);
    expect(fx.attempts()).toBe(2);
    expect(messages.some(m => m.metadata?.terminatedReason === 'turn_failed')).toBe(false);
  });

  it.each([false, true])('does not replay an async question after overload (delivery fails=%s)', async deliveryFails => {
    const fx = fixture('app-server', { failures: 1, special: 'async-question' }, CAPACITY_FAST);
    const onUserInput = vi.fn(() => deliveryFails
      ? Promise.reject(new Error('Owned card delivery failed')) : Promise.resolve());
    const onAsyncUserInputAnswer = vi.fn().mockResolvedValue(undefined);
    const messages = await collect(fx.query({ onUserInput, onAsyncUserInputAnswer }, {
      inputContext: { actorId: 'owned-actor', chatId: 'owned-chat', sourceMessageId: 'owned-overload-source' },
    }));
    expect(onUserInput).toHaveBeenCalledOnce();
    expect(onAsyncUserInputAnswer).not.toHaveBeenCalled();
    const results = messages.filter(message => message.type === 'result');
    expect(results).toHaveLength(1);
    if (deliveryFails) {
      // A genuine delivery accident is not capacity; the turn still fails.
      expect(fx.attempts()).toBe(1);
      expect(results[0].metadata?.terminatedReason).toBe('turn_failed');
      expect(results[0].metadata?.terminationDetail).toContain('Async question was not delivered');
    } else {
      // #5468: the delivered question is progress; the thread continues.
      expect(fx.attempts()).toBe(2);
      expect(results[0].metadata?.terminatedReason).toBeUndefined();
    }
  });

  it('does not replay the original input after a live steer', async () => {
    const fx = fixture('app-server', { failures: 1, special: 'steer' }, CAPACITY_FAST);
    const result = fx.query();
    let steered = false;
    const messages: AgentMessage[] = [];
    for await (const message of result.iterator) {
      messages.push(message);
      if (!steered && message.type === 'status' && message.metadata?.messageId) {
        steered = true;
        await result.handle.steer!('Preserve this correction');
      }
    }
    expect(steered).toBe(true);
    // #5468: the steer makes this post-progress; capacity continues the SAME
    // thread — the steer text stays in it, the recovery turn is instructed,
    // and the original input is never re-sent.
    expect(fx.attempts()).toBe(2);
    expect(fx.inputs()).toHaveLength(2);
    expect(fx.inputs()[1]).toContain('上一回合因模型容量暂时不足而中止');
    expect(fx.inputs()[0]).toContain('Complete the owned task');
    expect(fx.inputs().some(text => text.includes('Preserve this correction'))).toBe(false);
    expect(messages.some(m => m.metadata?.terminatedReason === 'turn_failed')).toBe(false);
  });
});
