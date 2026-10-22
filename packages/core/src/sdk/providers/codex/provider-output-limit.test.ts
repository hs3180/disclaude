import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '../../types.js';
import { CodexAgentProvider } from './provider.js';

type Transport = 'exec' | 'app-server';
interface Scenario {
  /** turn failure message from the upstream. */
  error: string;
  /** a successful commandExecution before the failure (real prior progress). */
  priorTool?: boolean;
  /** an incomplete, swollen commandExecution as the last tool step (#5452 shape). */
  swollenTool?: boolean;
  /** app-server only: turn/completed carries a usage payload. */
  usage?: boolean;
  /** fail the turn instead of completing it (default true for this suite). */
  fail?: boolean;
}
const owned: Array<{ provider: CodexAgentProvider; dir: string }> = [];

function fixture(transport: Transport, scenario: Scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-output-limit-'));
  const home = join(dir, 'home'), bin = join(dir, 'bin');
  mkdirSync(home); mkdirSync(bin);
  writeFileSync(join(home, 'auth.json'), '{}');
  const binary = join(bin, 'codex');
  writeFileSync(binary, `#!${process.execPath}
const fs=require('node:fs'),p=require('node:path'),scenario=${JSON.stringify(scenario)},transport=${JSON.stringify(transport)};
const file=name=>p.join(process.env.CODEX_HOME,name),send=m=>console.log(JSON.stringify(m));let currentTurn;
function run(turnId) {
 fs.appendFileSync(file('attempts'),'1\\n');
 const threadId='owned-limit-thread';
 const toolType=transport==='exec'?'command_execution':'commandExecution';
 const event=(phase,item)=>transport==='exec'?send({type:'item.'+phase,item}):send({method:'item/'+phase,params:{threadId,turnId,item}});
 if(scenario.priorTool){fs.appendFileSync(file('effects'),'effect\\n');const item={id:'prior',type:toolType,command:'printf ok >> report.mjs',aggregated_output:'done',status:'completed'};event('started',item);event('completed',item);}
 if(scenario.swollenTool){const item={id:'swollen',type:toolType,command:'X'.repeat(353433),status:'incomplete'};event('started',item);event('completed',item);}
 if(scenario.fail!==false){
  const error={message:scenario.error};
  if(transport==='exec')send({type:'turn.failed',error});
  else send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'failed',error,...(scenario.usage?{usage:{input_tokens:900000,cached_input_tokens:800000,output_tokens:128000,reasoning_output_tokens:151}}:{})}}});
  if(transport==='exec')process.exitCode=1;return;
 }
 event('completed',{id:'reply',type:transport==='exec'?'agent_message':'agentMessage',text:'all done'});
 if(transport==='exec')send({type:'turn.completed'});
 else send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});
}
if(transport==='exec'){send({type:'thread.started',thread_id:'owned-limit-thread'});send({type:'turn.started'});run('owned-exec-turn');}
else require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='model/list')send({id:m.id,result:{data:[{id:'gpt-6-luna',model:'gpt-6-luna',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]}});
 else if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:'owned-limit-thread'}}});
 else if(m.method==='turn/start'){currentTurn='owned-turn-'+Date.now();send({id:m.id,result:{turn:{id:currentTurn}}});run(currentTurn);}
 else if(m.method==='turn/steer')send({id:m.id,result:{turnId:currentTurn}});
 else if(m.method==='turn/interrupt')send({id:m.id,result:{}});
});
`);
  chmodSync(binary, 0o755);
  const provider = new CodexAgentProvider({ transport, model: 'gpt-6-luna', reasoningEffort: 'low', builtinsDir: dir,
    env: { PATH: bin, CODEX_HOME: home, CODEX_REASONING_EFFORT: '' } });
  const resource = { provider, dir }; owned.push(resource);
  const query = () => provider.queryStream((async function* (): AsyncGenerator<{ role: 'user'; content: string }> {
    yield { role: 'user', content: 'Refine the scheduled report task' };
  })(), { sessionKey: 'owned-limit', settingSources: [] });
  return { ...resource, query,
    attempts: () => readFileSync(join(home, 'attempts'), 'utf8').trim().split('\n'),
    effects: () => readFileSync(join(home, 'effects'), 'utf8').trim().split('\n') };
}
async function collect(result: ReturnType<CodexAgentProvider['queryStream']>) {
  const messages: AgentMessage[] = [];
  for await (const message of result.iterator) { messages.push(message); }
  return messages;
}
afterEach(() => {
  for (const resource of owned.splice(0)) { resource.provider.dispose(); rmSync(resource.dir, { recursive: true, force: true }); }
});

describe.each<Transport>(['exec', 'app-server'])('Codex %s output-limit classification (#5452)', transport => {
  const toolKind = transport === 'exec' ? 'command_execution' : 'commandExecution';

  it('classifies the max_output_tokens failure after real tool work, without retrying', async () => {
    const fx = fixture(transport, {
      error: 'Incomplete response returned, reason: max_output_tokens',
      priorTool: true, swollenTool: true, usage: true,
    });
    const messages = await collect(fx.query());
    // The turn already performed side effects — a replay would repeat them.
    expect(fx.attempts()).toHaveLength(1);
    expect(fx.effects()).toEqual(['effect']);
    const results = messages.filter(m => m.type === 'result');
    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.metadata?.terminatedReason).toBe('turn_failed');
    const outputLimit = result.metadata?.outputLimit as
      { usage?: { outputTokens?: number }; lastTool?: { kind: string; status?: string; inputLength?: number } };
    expect(outputLimit).toBeDefined();
    // Bounded telemetry: the swollen LAST tool wins over the earlier good one.
    expect(outputLimit.lastTool).toMatchObject({ kind: toolKind, status: 'incomplete', inputLength: 353433 });
    if (transport === 'app-server') {
      expect(outputLimit.usage).toMatchObject({ outputTokens: 128000 });
    } else {
      // exec turn.failed carries no usage payload — absent means unavailable.
      expect(outputLimit.usage).toBeUndefined();
    }
    expect(result.metadata?.terminationDetail).toContain('(output limit)');
    expect(result.metadata?.terminationDetail).toContain('max_output_tokens');
    expect(result.metadata?.terminationDetail).toContain('owned-limit-thread');
    // Never treated as an overload (no retry status, no replay).
    expect(messages.some(m => m.type === 'status' && m.content.includes('过载'))).toBe(false);
  });

  it('classifies with empty telemetry when the turn fails before any tool ran', async () => {
    const fx = fixture(transport, { error: 'Incomplete response returned, reason: max_output_tokens' });
    const messages = await collect(fx.query());
    const result = messages.find(m => m.type === 'result');
    expect(result?.metadata?.terminatedReason).toBe('turn_failed');
    expect(result?.metadata?.outputLimit).toEqual({});
    expect(result?.metadata?.terminationDetail).toContain('(output limit)');
  });

  it.each([
    'Incomplete response returned, reason: max_input_tokens',
    'stream disconnected before completion: tls handshake eof',
  ])('keeps unrelated failures generic (%s)', async error => {
    const fx = fixture(transport, { error, priorTool: true });
    const messages = await collect(fx.query());
    const result = messages.find(m => m.type === 'result');
    expect(result?.metadata?.terminatedReason).toBe('turn_failed');
    expect(result?.metadata?.outputLimit).toBeUndefined();
    expect(result?.metadata?.terminationDetail).not.toContain('(output limit)');
  });

  it('leaves normal long-tool-call successes untouched', async () => {
    const fx = fixture(transport, { error: '', priorTool: true, swollenTool: true, fail: false });
    const messages = await collect(fx.query());
    expect(messages.some(m => m.type === 'text' && m.content === 'all done')).toBe(true);
    const result = messages.find(m => m.type === 'result');
    expect(result?.metadata?.terminatedReason).toBeUndefined();
    expect(result?.metadata?.outputLimit).toBeUndefined();
  });
});
