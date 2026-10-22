import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentQueryOptions, UserInput } from '../../types.js';
import { CodexAgentProvider } from './provider.js';

/**
 * Issue #5467: a session that cannot receive async question forms used to
 * surface the raw host error ("Async question was not delivered:
 * asynchronous answers are unsupported in this conversation.") in the chat.
 * The unsupported class must degrade to a plain-text question and the turn
 * must complete normally; genuine delivery accidents keep failing.
 */
type HostBehavior = 'absent' | 'unsupported-reject' | 'delivers' | 'accident';
const owned: Array<{ provider: CodexAgentProvider; dir: string }> = [];

function fixture(behavior: HostBehavior) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-async-degrade-'));
  const home = join(dir, 'home'), bin = join(dir, 'bin');
  mkdirSync(home); mkdirSync(bin);
  writeFileSync(join(home, 'auth.json'), '{}');
  const binary = join(bin, 'codex');
  writeFileSync(binary, `#!${process.execPath}
const fs=require('node:fs'),p=require('node:path');
const file=name=>p.join(process.env.CODEX_HOME,name),send=m=>console.log(JSON.stringify(m));let currentTurn;
const threadId='degrade-thread';
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='model/list')send({id:m.id,result:{data:[{id:'gpt-6-luna',model:'gpt-6-luna',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]}});
 else if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:threadId}}});
 else if(m.method==='turn/start'){
  currentTurn='degrade-turn-'+Date.now();
  fs.appendFileSync(file('prompts'),JSON.stringify(m.params.input)+'\\n===END===\\n');
  send({id:m.id,result:{turn:{id:currentTurn}}});
  // An async question item (model-catalog registered tool, native
  // accepted:true implied), then a normally completing turn.
  send({method:'item/completed',params:{threadId,turnId:currentTurn,item:{id:'q-item',type:'agentMessage',text:'Which scope?',delivery:'async',questions:[{title:'Which scope? ',options:['A — narrow','B — everything']}]}}});
  send({method:'turn/completed',params:{threadId,turn:{id:currentTurn,status:'completed'}}});
 }
 else if(m.method==='turn/steer')send({id:m.id,result:{turnId:currentTurn}});
 else if(m.method==='turn/interrupt')send({id:m.id,result:{}});
});
`);
  chmodSync(binary, 0o755);
  const provider = new CodexAgentProvider({ transport: 'app-server', model: 'gpt-6-luna', reasoningEffort: 'low',
    builtinsDir: dir, env: { PATH: bin, CODEX_HOME: home, CODEX_REASONING_EFFORT: '' } });
  const resource = { provider, dir }; owned.push(resource);
  const hostInput = behavior === 'unsupported-reject'
    ? vi.fn(() => Promise.reject(Object.assign(
      new Error('This channel cannot answer SDK input requests'),
      { code: 'AGENT_ASYNC_INPUT_UNSUPPORTED' },
    )))
    : behavior === 'delivers' ? vi.fn(() => Promise.resolve())
      : behavior === 'accident' ? vi.fn(() => Promise.reject(new Error('private card explosion')))
        : undefined;
  const onAsyncUserInputAnswer = behavior === 'absent' ? undefined : vi.fn();
  const query = () => {
    const input: UserInput = {
      role: 'user', content: 'Proceed with the refinement',
      correlation: { runId: 'degrade-run', chatId: 'degrade-chat', sourceMessageId: 'degrade-source', traceId: 'degrade-trace' },
      // inputContext present for every wired host so the degrade differences
      // below come from the host behavior alone.
      inputContext: { chatId: 'degrade-chat', actorId: 'degrade-actor', sourceMessageId: 'degrade-source' },
    };
    const extra: Partial<AgentQueryOptions> = hostInput
      ? { onUserInput: hostInput, ...(onAsyncUserInputAnswer ? { onAsyncUserInputAnswer } : {}) }
      : {};
    return provider.queryStream((async function* (): AsyncGenerator<UserInput> { yield input; })(),
      { sessionKey: 'degrade-session', settingSources: [], ...extra });
  };
  return { ...resource, query, hostInput, prompts: () => readFileSync(join(home, 'prompts'), 'utf8') };
}
async function collect(result: ReturnType<CodexAgentProvider['queryStream']>) {
  const messages: AgentMessage[] = [];
  for await (const message of result.iterator) { messages.push(message); }
  return messages;
}
afterEach(() => {
  for (const resource of owned.splice(0)) { resource.provider.dispose(); rmSync(resource.dir, { recursive: true, force: true }); }
});

describe('Codex async-question capability degrade (#5467)', () => {
  it('degrades to a plain-text question and a successful turn when no interactive host is wired', async () => {
    const fx = fixture('absent');
    const messages = await collect(fx.query());
    const degraded = messages.find(m => m.type === 'text' && m.content.includes('任务需要你的输入'));
    expect(degraded).toBeDefined();
    expect(degraded?.content).toContain('Which scope?');
    expect(degraded?.content).toContain('A — narrow / B — everything');
    // The host error string never reaches the chat, and the turn succeeds.
    expect(messages.some(m => m.type === 'error')).toBe(false);
    expect(messages.some(m => m.content.includes('asynchronous answers are unsupported'))).toBe(false);
    expect(messages.find(m => m.type === 'result')?.metadata?.terminatedReason).toBeUndefined();
    // Wiring knew interactive answers were impossible: the prompt says so.
    expect(fx.prompts()).toContain('This conversation cannot receive asynchronous question forms');
  });

  it('degrades the once-mode / stale-session rejection the same way', async () => {
    const fx = fixture('unsupported-reject');
    const messages = await collect(fx.query());
    expect(fx.hostInput).toHaveBeenCalledOnce();
    expect(messages.find(m => m.type === 'text' && m.content.includes('任务需要你的输入'))).toBeDefined();
    expect(messages.some(m => m.type === 'error')).toBe(false);
    expect(messages.find(m => m.type === 'result')?.metadata?.terminatedReason).toBeUndefined();
    // Capability was wired, so the prompt carries no blanket prohibition.
    expect(fx.prompts()).not.toContain('cannot receive asynchronous question forms');
  });

  it('keeps delivering through a working interactive host', async () => {
    const fx = fixture('delivers');
    const messages = await collect(fx.query());
    expect(fx.hostInput).toHaveBeenCalledOnce();
    expect(messages.some(m => m.type === 'text' && m.content.includes('任务需要你的输入'))).toBe(false);
    expect(messages.some(m => m.type === 'error')).toBe(false);
    expect(fx.prompts()).not.toContain('cannot receive asynchronous question forms');
  });

  it('still surfaces genuine delivery accidents as turn failures', async () => {
    const fx = fixture('accident');
    const messages = await collect(fx.query());
    expect(fx.hostInput).toHaveBeenCalledOnce();
    expect(messages.some(m => m.type === 'text' && m.content.includes('任务需要你的输入'))).toBe(false);
    expect(messages.find(m => m.type === 'result')?.metadata?.terminatedReason).toBe('turn_failed');
    // The raw private sender detail stays out; the class hint is visible.
    expect(messages.some(m => m.content.includes('private card explosion'))).toBe(false);
    expect(messages.some(m => m.content.includes('could not confirm card delivery'))).toBe(true);
  });
});
