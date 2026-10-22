import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, UserInput } from '../../types.js';
import { CodexAgentProvider } from './provider.js';
import { codexCapacityRecoveryDelay, readCodexCapacityRecoveryPolicy, readCodexOverloadFailure } from './overload-policy.js';

/**
 * Issue #5468: a capacity (serverOverloaded / 503) failure that struck AFTER
 * the turn already produced output or tool calls used to settle the whole
 * task. It must instead continue on the SAME thread — recovery instruction,
 * never a replay of the original input — bounded by attempts and a wall-clock
 * budget, settling exactly once. 429-style throttles stay on the pre-work
 * path and do NOT continue.
 */
interface Scenario {
  failures: number;
  throttle?: boolean;
  retryAfter?: string;
}
const owned: Array<{ provider: CodexAgentProvider; dir: string }> = [];
const FAST = {
  DISCLAUDE_CODEX_CAPACITY_RECOVERY_INITIAL_DELAY_MS: '40',
  DISCLAUDE_CODEX_CAPACITY_RECOVERY_MAX_DELAY_MS: '40',
};

function fixture(scenario: Scenario, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-capacity-5468-'));
  const home = join(dir, 'home'), bin = join(dir, 'bin');
  mkdirSync(home); mkdirSync(bin);
  writeFileSync(join(home, 'auth.json'), '{}');
  const binary = join(bin, 'codex');
  writeFileSync(binary, `#!${process.execPath}
const fs=require('node:fs'),p=require('node:path'),scenario=${JSON.stringify(scenario)};
const file=name=>p.join(process.env.CODEX_HOME,name),send=m=>console.log(JSON.stringify(m));let currentTurn;
const threadId='capacity-thread';
const count=()=>fs.existsSync(file('attempts'))?Number(fs.readFileSync(file('attempts'),'utf8')):0;
function run(turnId) {
 const attempt=count()+1;
 fs.writeFileSync(file('attempts'),String(attempt));fs.appendFileSync(file('times'),Date.now()+'\\n');
 if(attempt<=scenario.failures) {
  fs.appendFileSync(file('effects'),'effect\\n');
  const item={id:'work-'+attempt,type:'commandExecution',command:'owned effect',aggregated_output:'done',status:'completed'};
  send({method:'item/started',params:{threadId,turnId,item}});
  send({method:'item/completed',params:{threadId,turnId,item}});
  const error=scenario.throttle
   ?{message:'429 Too Many Requests: rate limit reached',codexErrorInfo:'other'}
   :{message:'server_overloaded: Selected model is at capacity. Please try a different model.',codexErrorInfo:'serverOverloaded',...(scenario.retryAfter?{additionalDetails:'Retry-After: '+scenario.retryAfter}:{})};
  send({method:'error',params:{threadId,turnId,error,willRetry:false}});
  send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'failed',error}}});
 } else {
  send({method:'item/completed',params:{threadId,turnId,item:{id:'reply-'+attempt,type:'agentMessage',text:'capacity-recovered'}}});
  send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});
 }
}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='model/list')send({id:m.id,result:{data:[{id:'gpt-6-luna',model:'gpt-6-luna',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]}});
 else if(m.method==='thread/start'){fs.appendFileSync(file('threads'),'thread/start\\n');send({id:m.id,result:{thread:{id:threadId}}});}
 else if(m.method==='thread/resume'){fs.appendFileSync(file('threads'),'thread/resume '+m.params.threadId+'\\n');send({id:m.id,result:{thread:{id:threadId}}});}
 else if(m.method==='turn/start'){
  currentTurn='capacity-turn-'+Date.now();
  fs.appendFileSync(file('inputs'),JSON.stringify(m.params.input)+'\\n===END===\\n');
  send({id:m.id,result:{turn:{id:currentTurn}}});
  run(currentTurn);
 }
 else if(m.method==='turn/interrupt')send({id:m.id,result:{}});
});
`);
  chmodSync(binary, 0o755);
  const provider = new CodexAgentProvider({ transport: 'app-server', model: 'gpt-6-luna', reasoningEffort: 'low', builtinsDir: dir,
    env: { PATH: bin, CODEX_HOME: home, CODEX_REASONING_EFFORT: '', ...FAST, ...extraEnv } });
  const resource = { provider, dir }; owned.push(resource);
  const query = () => provider.queryStream((async function* (): AsyncGenerator<UserInput> {
    yield { role: 'user', content: 'Complete the capacity task', correlation: { runId: 'cap-run', chatId: 'cap-chat', sourceMessageId: 'cap-source', traceId: 'cap-trace' } };
  })(), { sessionKey: 'capacity-5468', settingSources: [] });
  return { ...resource, query,
    attempts: () => Number(readFileSync(join(home, 'attempts'), 'utf8')),
    effects: () => readFileSync(join(home, 'effects'), 'utf8').trim().split('\n'),
    inputs: () => readFileSync(join(home, 'inputs'), 'utf8').trim().split('\n===END===\n'),
    threads: () => readFileSync(join(home, 'threads'), 'utf8').trim().split('\n'),
    times: () => readFileSync(join(home, 'times'), 'utf8').trim().split('\n').map(Number),
    recoveryStatuses: (messages: AgentMessage[]) =>
      messages.filter(m => m.type === 'status' && m.content.includes('自动续接')).length };
}
async function collect(result: ReturnType<CodexAgentProvider['queryStream']>) {
  const messages: AgentMessage[] = [];
  for await (const message of result.iterator) { messages.push(message); }
  return messages;
}
afterEach(() => {
  for (const resource of owned.splice(0)) { resource.provider.dispose(); rmSync(resource.dir, { recursive: true, force: true }); }
});

describe('Codex capacity continuation (#5468)', () => {
  it('continues the same thread after post-progress capacity without replaying the original input', async () => {
    const fx = fixture({ failures: 1 });
    const messages = await collect(fx.query());
    expect(fx.attempts()).toBe(2);
    expect(fx.threads()).toEqual(['thread/start', 'thread/resume capacity-thread']);
    const [first, second] = fx.inputs();
    expect(first).toContain('Complete the capacity task');
    expect(second).toContain('上一回合因模型容量暂时不足而中止');
    expect(second).not.toContain('Complete the capacity task');
    // Host-side effects are never replayed; the model verifies instead.
    expect(fx.effects()).toHaveLength(1);
    expect(fx.recoveryStatuses(messages)).toBe(1);
    const results = messages.filter(m => m.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0].metadata?.terminatedReason).toBeUndefined();
    expect(messages.filter(m => m.type === 'text').map(m => m.content)).toEqual(['capacity-recovered']);
    expect(messages.some(m => m.type === 'error')).toBe(false);
  });

  it('respects a server Retry-After hint before continuing', async () => {
    const fx = fixture({ failures: 1, retryAfter: '1' });
    const messages = await collect(fx.query());
    expect(fx.attempts()).toBe(2);
    expect(fx.times()[1]! - fx.times()[0]!).toBeGreaterThanOrEqual(980);
    expect(fx.recoveryStatuses(messages)).toBe(1);
  });

  it('settles once when the hint exceeds the remaining wall-clock budget', async () => {
    const fx = fixture({ failures: 1, retryAfter: '3600' }, { DISCLAUDE_CODEX_CAPACITY_RECOVERY_BUDGET_MS: '5000' });
    const messages = await collect(fx.query());
    expect(fx.attempts()).toBe(1);
    expect(fx.recoveryStatuses(messages)).toBe(0);
    const results = messages.filter(m => m.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0].metadata?.terminatedReason).toBe('turn_failed');
    expect(results[0].content).toContain('Selected model is at capacity');
  });

  it('bounds attempts and settles exactly once when capacity persists', async () => {
    const fx = fixture({ failures: 10 }, { DISCLAUDE_CODEX_CAPACITY_RECOVERY_MAX_ATTEMPTS: '2' });
    const messages = await collect(fx.query());
    expect(fx.attempts()).toBe(3);
    expect(fx.recoveryStatuses(messages)).toBe(2);
    const results = messages.filter(m => m.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0].metadata?.terminatedReason).toBe('turn_failed');
    expect(results[0].metadata?.terminationDetail).toContain('capacityRecoveryAttempts=2');
    expect(results[0].content).toContain('已自动续接 2 次');
  });

  it('stops continuing once the wall-clock budget is spent', async () => {
    const fx = fixture({ failures: 10, retryAfter: '1' }, { DISCLAUDE_CODEX_CAPACITY_RECOVERY_BUDGET_MS: '1500' });
    const messages = await collect(fx.query());
    expect(fx.attempts()).toBe(2);
    expect(fx.recoveryStatuses(messages)).toBe(1);
    expect(messages.filter(m => m.type === 'result')).toHaveLength(1);
    expect(messages.some(m => m.metadata?.terminatedReason === 'turn_failed')).toBe(true);
  });

  it('does not continue a 429 throttle after progress', async () => {
    const fx = fixture({ failures: 1, throttle: true });
    const messages = await collect(fx.query());
    expect(fx.attempts()).toBe(1);
    expect(fx.recoveryStatuses(messages)).toBe(0);
    expect(messages.some(m => m.metadata?.terminatedReason === 'turn_failed')).toBe(true);
  });

  it('cancels the recovery wait without a second attempt', async () => {
    const fx = fixture({ failures: 1 });
    const result = fx.query();
    let sawRecovery = false;
    for await (const message of result.iterator) {
      if (message.type === 'status' && message.content.includes('自动续接')) { sawRecovery = true; result.handle.cancel(); }
    }
    expect(sawRecovery).toBe(true);
    await vi.waitFor(() => expect(fx.provider.getGovernanceStats().runningRuns).toBe(0));
    expect(fx.attempts()).toBe(1);
  });
});

describe('codexCapacityRecoveryDelay policy (#5468)', () => {
  const policy = readCodexCapacityRecoveryPolicy({});
  const capacity = readCodexOverloadFailure({ message: 'server_overloaded: Selected model is at capacity', codexErrorInfo: 'serverOverloaded' });

  it('classifies capacity apart from throttles', () => {
    expect(capacity?.capacity).toBe(true);
    expect(readCodexOverloadFailure({ message: '429 Too Many Requests: rate limit reached' })?.capacity).toBe(false);
    expect(readCodexOverloadFailure({ message: 'HTTP 503 Service Unavailable' })?.capacity).toBe(true);
    expect(readCodexOverloadFailure({ message: 'stream disconnected', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 429 } } })?.capacity).toBe(false);
    expect(readCodexOverloadFailure({ message: 'stream disconnected', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } } })?.capacity).toBe(true);
  });

  it('declines non-capacity failures and exhausted attempts', () => {
    expect(codexCapacityRecoveryDelay({ message: 'not capacity' }, 0, Date.now(), policy)).toBeUndefined();
    expect(codexCapacityRecoveryDelay(capacity!, policy.maxAttempts, Date.now(), policy)).toBeUndefined();
  });

  it('never shortens a server hint to fit the remaining budget', () => {
    const hint = { ...capacity!, retryAfterMs: 60_000 };
    const now = () => 1_000_000;
    expect(codexCapacityRecoveryDelay(hint, 0, now(), { ...policy, budgetMs: 30_000 }, now)).toBeUndefined();
    expect(codexCapacityRecoveryDelay(hint, 0, now(), { ...policy, budgetMs: 180_000 }, now)).toBeGreaterThanOrEqual(60_000);
  });
});
