import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentQueryOptions, UserInput } from '../../types.js';
import { CodexAgentProvider } from './provider.js';

/**
 * T-040 (#5430): a push-initialized turn carries no interactive input context
 * (handleSystemMessage routes push_* system messages without senderOpenId, so
 * chat-agent binds no inputContext). A BLOCKING RPC question in such a turn is
 * rejected host-side ("This channel cannot answer SDK input requests"). The
 * rejection must land in the #5526 structured local-failure semantics — the
 * natively completed turn keeps its terminal state and the failure rides the
 * success result as bounded metadata — instead of an unlabelled protocol
 * cancellation that reclassifies the turn.
 */
const owned: Array<{ provider: CodexAgentProvider; dir: string }> = [];

function pushFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-push-input-'));
  const home = join(dir, 'home'), bin = join(dir, 'bin');
  mkdirSync(home); mkdirSync(bin);
  writeFileSync(join(home, 'auth.json'), '{}');
  const binary = join(bin, 'codex');
  writeFileSync(binary, `#!${process.execPath}
const p=require('node:path'),send=m=>console.log(JSON.stringify(m));let currentTurn;
const threadId='push-thread';
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='model/list')send({id:m.id,result:{data:[{id:'gpt-6-luna',model:'gpt-6-luna',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]}});
 else if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:threadId}}});
 else if(m.method==='turn/start'){
  currentTurn='push-turn-'+Date.now();
  send({id:m.id,result:{turn:{id:currentTurn}}});
  send({id:'rpc-input-1',method:'item/tool/requestUserInput',params:{threadId,turnId:currentTurn,itemId:'rpc-q-item',isBlocking:true,questions:[{id:'q1',header:'',question:'Proceed with which scope?',isOther:false,isSecret:false,options:[{label:'A',description:''},{label:'B',description:''}]}]}});
  setTimeout(()=>send({method:'turn/completed',params:{threadId,turn:{id:currentTurn,status:'completed'}}}),60);
 }
 else if(m.method==='turn/steer')send({id:m.id,result:{turnId:currentTurn}});
 else if(m.method==='turn/interrupt')send({id:m.id,result:{}});
});
`);
  chmodSync(binary, 0o755);
  const provider = new CodexAgentProvider({ transport: 'app-server', model: 'gpt-6-luna', reasoningEffort: 'low',
    builtinsDir: dir, env: { PATH: bin, CODEX_HOME: home, CODEX_REASONING_EFFORT: '' } });
  owned.push({ provider, dir });
  // The chat-agent rejects a push-initialized turn's input exactly this way
  // (no inputContext → sdkOptions.onUserInput throws, chat-agent.ts).
  const hostInput = vi.fn(() => Promise.reject(new Error('This channel cannot answer SDK input requests')));
  const query = () => {
    // Push-initialized shape: correlation present, inputContext ABSENT.
    const input: UserInput = {
      role: 'user', content: 'Refine the group topic draft',
      correlation: { runId: 'push-run', chatId: 'push-chat', sourceMessageId: 'push_source_1', traceId: 'push-trace' },
    };
    const extra: Partial<AgentQueryOptions> = { onUserInput: hostInput, onAsyncUserInputAnswer: vi.fn() };
    return provider.queryStream((async function* (): AsyncGenerator<UserInput> { yield input; })(),
      { sessionKey: 'push-session', settingSources: [], ...extra });
  };
  return { query, hostInput };
}

async function collect(result: ReturnType<CodexAgentProvider['queryStream']>) {
  const messages: AgentMessage[] = [];
  for await (const message of result.iterator) { messages.push(message); }
  return messages;
}

afterEach(() => {
  for (const resource of owned.splice(0)) { resource.provider.dispose(); rmSync(resource.dir, { recursive: true, force: true }); }
});

describe('push-initialized turn blocking input (#5430 / T-040)', () => {
  it('keeps the completed terminal state and reports the rejection as structured #5526 metadata', async () => {
    const fx = pushFixture();
    const messages = await collect(fx.query());
    expect(fx.hostInput).toHaveBeenCalledOnce();
    const result = messages.find(m => m.type === 'result');
    // Terminal state preserved: a local input rejection is not a turn failure.
    expect(result?.metadata?.terminatedReason).toBeUndefined();
    expect(result?.metadata?.inputDeliveryFailure).toEqual({ nativeCompleted: true,
      reason: expect.stringContaining('could not confirm card delivery') });
    expect(result?.metadata?.automaticReplayBlocked).toBe('async-input-delivery-failed');
    // The bounded class hint reaches the chat; the raw host string does not.
    expect(messages.some(m => m.content.includes('This channel cannot answer SDK input requests'))).toBe(false);
  });
});
