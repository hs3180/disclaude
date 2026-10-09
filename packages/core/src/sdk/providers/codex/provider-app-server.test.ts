import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentQueryOptions, ToolDefinition, ToolContext, UserInput } from '../../types.js';
import { CodexAgentProvider } from './provider.js';
import type { AgentInputRequest, AgentInputContext } from '../../user-input.js';

const dirs: string[] = [];
function providerFixture(
  body: string,
  transport: 'exec' | 'app-server' | undefined = 'app-server',
  extraEnv: Record<string, string> = {},
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
      env: { PATH: bin, CODEX_HOME: home, CODEX_REASONING_EFFORT: '', ...extraEnv },
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
  it('rejects host tools before starting codex exec', () => {
    const { provider } = providerFixture('exit 0', 'exec');
    const tools: ToolDefinition[] = [{ name: 'read_notebook', description: 'Read', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, execute: () => Promise.resolve({}) }];
    const input = (async function* (): AsyncGenerator<UserInput> {
      yield { role: 'user', content: 'Read the notebook' };
    })();
    try {
      expect(() => provider.queryStream(input, {
        sessionKey: 'exec-host-tool', settingSources: [], tools,
      } as AgentQueryOptions)).toThrow(/require agent\.codex\.transport: app-server/);
    } finally { provider.dispose(); }
  });

  it('registers and executes a host tool on the active turn', async () => {
    const { provider, dir } = providerFixture('exit 0', 'app-server', { DISCLAUDE_STALL_TIMEOUT_MS: '40' });
    writeFileSync(join(dir, 'bin', 'codex'), `#!${process.execPath}
const fs=require('node:fs');const send=m=>console.log(JSON.stringify(m));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize'){fs.writeFileSync(process.env.CODEX_HOME+'/initialize',JSON.stringify(m.params));send({id:m.id,result:{}});}
 else if(m.method==='initialized'){}
 else if(m.method==='thread/start'){fs.writeFileSync(process.env.CODEX_HOME+'/thread',JSON.stringify(m.params));send({id:m.id,result:{thread:{id:'dynamic-thread'}}});}
 else if(m.method==='model/list')send({id:m.id,result:{data:[{id:'gpt-6-luna',model:'gpt-6-luna',supportedReasoningEfforts:[{reasoningEffort:'max'}]}]}});
 else if(m.method==='turn/start'){
  send({id:m.id,result:{turn:{id:'dynamic-turn'}}});
  send({method:'item/started',params:{threadId:'dynamic-thread',turnId:'dynamic-turn',item:{id:'host-item',type:'dynamicToolCall'}}});
  send({id:'host-request',method:'item/tool/call',params:{callId:'host-call',threadId:'dynamic-thread',turnId:'dynamic-turn',namespace:'disclaude',tool:'read_notebook',arguments:{path:'research.ipynb'}}});
 } else if(m.id==='host-request'){
  fs.writeFileSync(process.env.CODEX_HOME+'/tool-result',JSON.stringify(m.result));
  send({method:'item/completed',params:{threadId:'dynamic-thread',turnId:'dynamic-turn',item:{id:'host-item',type:'dynamicToolCall',status:'completed'}}});
  send({method:'item/completed',params:{threadId:'dynamic-thread',turnId:'dynamic-turn',item:{id:'reply',type:'agentMessage',text:'Notebook read completed'}}});
  send({method:'turn/completed',params:{threadId:'dynamic-thread',turn:{id:'dynamic-turn',status:'completed'}}});
 }
});`);
    const handler = vi.fn(async (params: Record<string, unknown>, context: ToolContext) => {
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(context?.signal.aborted).toBe(false);
      return { path: params.path, documentId: 'doc-1' };
    });
    const definition: ToolDefinition = {
      name: 'read_notebook',
      description: 'Read a Jupyter notebook',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      outputSchema: { type: 'object' },
      execute: handler,
    };
    const tools = [definition];
    const result = provider.queryStream((async function* (): AsyncGenerator<UserInput> {
      yield { role: 'user', content: 'Read the notebook' };
    })(), {
      sessionKey: 'dynamic-tools', settingSources: [], tools,
    } as AgentQueryOptions);
    const messages: AgentMessage[] = [];
    try {
      for await (const message of result.iterator) { messages.push(message); }
      expect(JSON.parse(readFileSync(join(dir, 'home/initialize'), 'utf8')).capabilities).toEqual({ experimentalApi: true });
      expect(JSON.parse(readFileSync(join(dir, 'home/thread'), 'utf8')).dynamicTools).toMatchObject([
        {
          type: 'namespace',
          name: 'disclaude',
          tools: [{ type: 'function', name: 'read_notebook', inputSchema: { type: 'object' } }],
        },
      ]);
      expect(JSON.parse(readFileSync(join(dir, 'home/tool-result'), 'utf8'))).toEqual({
        success: true,
        contentItems: [{ type: 'inputText', text: '{"path":"research.ipynb","documentId":"doc-1"}' }],
      });
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0]?.[1]).toMatchObject({
      });
      expect(messages).toContainEqual(expect.objectContaining({ type: 'text', content: 'Notebook read completed' }));
      expect(messages.some(message => message.metadata?.terminatedReason === 'stall')).toBe(false);
    } finally { provider.dispose(); }
  });

  it('dispatches host tools after resuming the same thread on a new app-server process', async () => {
    const { provider, dir } = providerFixture('exit 0', 'app-server');
    writeFileSync(join(dir, 'bin', 'codex'), `#!${process.execPath}
const fs=require('node:fs');const send=m=>console.log(JSON.stringify(m));let marker='first';let turnId='';let requestId='';
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='initialized'){}
 else if(m.method==='thread/start'||m.method==='thread/resume'){
  marker=m.method==='thread/start'?'first':'second';
  fs.appendFileSync(process.env.CODEX_HOME+'/methods',JSON.stringify({method:m.method,params:m.params})+'\\n');
  send({id:m.id,result:{thread:{id:'continued-thread'}}});
 } else if(m.method==='model/list')send({id:m.id,result:{data:[{id:'gpt-6-luna',model:'gpt-6-luna',supportedReasoningEfforts:[{reasoningEffort:'max'}]}]}});
 else if(m.method==='turn/start'){
  turnId=marker+'-turn';requestId=marker+'-request';
  send({id:m.id,result:{turn:{id:turnId}}});
  send({method:'item/started',params:{threadId:'continued-thread',turnId,item:{id:marker+'-tool',type:'dynamicToolCall'}}});
  send({id:requestId,method:'item/tool/call',params:{callId:marker+'-call',threadId:'continued-thread',turnId,namespace:'disclaude',tool:'emit_marker',arguments:{marker}}});
 } else if(m.id===requestId){
  send({method:'item/completed',params:{threadId:'continued-thread',turnId,item:{id:marker+'-tool',type:'dynamicToolCall',status:'completed'}}});
  send({method:'item/completed',params:{threadId:'continued-thread',turnId,item:{id:marker+'-reply',type:'agentMessage',text:marker+' host tool completed'}}});
  send({method:'turn/completed',params:{threadId:'continued-thread',turn:{id:turnId,status:'completed'}}});
 }
});`);
    const handler = vi.fn((params: Record<string, unknown>) => Promise.resolve({ accepted: true, marker: params.marker }));
    const tools: ToolDefinition[] = [{ name: 'emit_marker', description: 'Record a turn marker', inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'] }, outputSchema: { type: 'object' }, execute: handler }];
    const result = provider.queryStream((async function* (): AsyncGenerator<UserInput> {
      yield { role: 'user', content: 'Record the first marker' };
      yield { role: 'user', content: 'Record the second marker' };
    })(), {
      sessionKey: 'dynamic-tool-resume', settingSources: [], tools,
    } as AgentQueryOptions);
    const messages: AgentMessage[] = [];
    try {
      for await (const message of result.iterator) { messages.push(message); }
      const threadRequests = readFileSync(join(dir, 'home/methods'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(threadRequests.map(request => request.method)).toEqual(['thread/start', 'thread/resume']);
      expect(threadRequests[0].params.dynamicTools).toMatchObject([
        { type: 'namespace', name: 'disclaude', tools: [{ type: 'function', name: 'emit_marker' }] },
      ]);
      expect(threadRequests[1].params).not.toHaveProperty('dynamicTools');
      expect(handler.mock.calls.map(call => call[0].marker)).toEqual(['first', 'second']);
      expect(messages.filter(message => message.type === 'text').map(message => message.content)).toEqual([
        'first host tool completed', 'second host tool completed',
      ]);
      expect(messages.filter(message => message.type === 'status').map(message => message.metadata?.sessionId)).toEqual([
        'continued-thread', 'continued-thread',
      ]);
    } finally { provider.dispose(); }
  });

  it('requires a conversation reset before changing a resumed thread tool registry', async () => {
    const { provider, dir } = providerFixture('exit 0', 'app-server');
    writeFileSync(join(dir, 'bin', 'codex'), `#!${process.execPath}
const fs=require('node:fs');const send=m=>console.log(JSON.stringify(m));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='initialized'){}
 else if(m.method==='thread/start'||m.method==='thread/resume'){
  fs.appendFileSync(process.env.CODEX_HOME+'/methods',m.method+'\\n');
  fs.writeFileSync(process.env.CODEX_HOME+'/thread',JSON.stringify(m.params));
  send({id:m.id,result:{thread:{id:'registry-thread'}}});
 } else if(m.method==='model/list')send({id:m.id,result:{data:[{id:'gpt-6-luna',model:'gpt-6-luna',supportedReasoningEfforts:[{reasoningEffort:'max'}]}]}});
 else if(m.method==='turn/start'){
  send({id:m.id,result:{turn:{id:'registry-turn'}}});
  send({method:'item/completed',params:{threadId:'registry-thread',turnId:'registry-turn',item:{id:'reply',type:'agentMessage',text:'done'}}});
  send({method:'turn/completed',params:{threadId:'registry-thread',turn:{id:'registry-turn',status:'completed'}}});
 }
});`);
    const makeTools = (name: string): ToolDefinition[] => [{ name, description: 'Jupyter tool', inputSchema: { type: 'object' }, outputSchema: { type: 'string' }, execute: () => Promise.resolve('ok') }];
    const input = () => (async function* (): AsyncGenerator<UserInput> {
      yield { role: 'user', content: 'Continue the notebook work' };
    })();
    try {
      const first = provider.queryStream(input(), {
        sessionKey: 'registry-change', settingSources: [], tools: makeTools('read_notebook'),
      } as AgentQueryOptions);
      for await (const _message of first.iterator) { /* drain */ }
      expect(JSON.parse(readFileSync(join(dir, 'home/thread'), 'utf8')).dynamicTools)
        .toMatchObject([
          { type: 'namespace', tools: [{ type: 'function', name: 'read_notebook' }] },
        ]);
      expect(() => provider.queryStream(input(), {
        sessionKey: 'registry-change', settingSources: [], tools: makeTools('execute_cell'),
      } as AgentQueryOptions)).toThrow(/different host tool registry/);
      expect(() => provider.queryStream(input(), {
        sessionKey: 'registry-change', settingSources: [], tools: [{ ...makeTools('read_notebook')[0], outputSchema: { type: 'object' } }],
      })).toThrow(/different host tool registry/);
      expect(readFileSync(join(dir, 'home/methods'), 'utf8').trim().split('\n')).toEqual(['thread/start']);
    } finally { provider.dispose(); }
  });

  it.each([
    { isBlocking: true, completes: true },
    { isBlocking: false, completes: true },
    { isBlocking: true, completes: false },
    { isBlocking: false, completes: false },
  ])('returns delayed answers and resumes watchdog (blocking=$isBlocking, completes=$completes)', async ({ isBlocking, completes }) => {
    const { provider, dir } = providerFixture('exit 0', 'app-server', { DISCLAUDE_STALL_TIMEOUT_MS: '50' });
    writeFileSync(join(dir, 'bin', 'codex'), `#!${process.execPath}
const fs=require('node:fs'); const send=m=>console.log(JSON.stringify(m)); let starts=0;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(m.method==='initialized')return;
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'input-thread'}}});
 else if(m.method==='turn/start'){
  starts++;fs.writeFileSync(process.env.CODEX_HOME+'/prompt',m.params.input[0].text);
  send({id:'question-rpc',method:'item/tool/requestUserInput',params:{threadId:'input-thread',turnId:'input-turn',itemId:'input-item',isBlocking:${JSON.stringify(isBlocking)},questions:[{id:'choice',header:'Choice',question:'Which browser?',options:[{label:'Chromium',description:'Separate profile'}]}]}});
  send({id:m.id,result:{turn:{id:'input-turn'}}});
 } else if(m.id==='question-rpc'){
  fs.writeFileSync(process.env.CODEX_HOME+'/answer',JSON.stringify({...m,starts}));
  send({method:'item/completed',params:{threadId:'input-thread',turnId:'input-turn',item:{id:'final',type:'agentMessage',text:'Continued original turn'}}});
  if (${JSON.stringify(completes)}) send({method:'turn/completed',params:{threadId:'input-thread',turn:{id:'input-turn',status:'completed'}}});
 } else {fs.writeFileSync(process.env.CODEX_HOME+'/unexpected',m.method||'unknown');}
});`);
    const context = { actorId: 'original-actor', chatId: 'original-chat', sourceMessageId: 'original-source' };
    const onUserInput = vi.fn(async (request: AgentInputRequest, inputContext: AgentInputContext | undefined) => {
      expect(inputContext).toEqual(context);
      expect(request.isBlocking).toBe(isBlocking);
      expect(request.signal.aborted).toBe(false);
      // Human input can arrive after the ordinary stall deadline even for a non-blocking request.
      await new Promise(resolve => setTimeout(resolve, 150));
      await request.respond({ choice: { answers: ['Chromium'] } });
    });
    const stream = provider.queryStream((async function* (): AsyncGenerator<UserInput> { yield { role: 'user', content: 'Choose a browser', inputContext: context }; })(), {
      sessionKey: 'host-input', settingSources: [], onUserInput,
    });
    const messages: AgentMessage[] = [];
    try {
      for await (const message of stream.iterator) { messages.push(message); }
      expect(onUserInput).toHaveBeenCalledTimes(1);
      expect(JSON.parse(readFileSync(join(dir, 'home/answer'), 'utf8'))).toMatchObject({ id: 'question-rpc', starts: 1,
        result: { answers: { choice: { answers: ['Chromium'] } } } });
      expect(messages.some(m => m.type === 'text' && m.content === 'Continued original turn')).toBe(true);
      expect(messages.some(m => m.type === 'result' && m.metadata?.terminatedReason === 'stall')).toBe(!completes);
      expect(messages.some(m => m.type === 'error' && m.content.includes('stalled'))).toBe(false);
      expect(readFileSync(join(dir, 'home/prompt'), 'utf8')).not.toContain('original-actor');
    } finally { stream.handle.close(); provider.dispose(); }
  });

  it('does not fire the stall watchdog while an app-server tool is active', async () => {
    const { provider, dir } = providerFixture('exit 0', 'app-server', { DISCLAUDE_STALL_TIMEOUT_MS: '40' });
    writeFileSync(join(dir, 'bin', 'codex'), `#!${process.execPath}
const readline = require('node:readline');
const send = message => console.log(JSON.stringify(message));
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ id: request.id, result: {} });
  else if (request.method === 'thread/start' || request.method === 'thread/resume') {
    send({ id: request.id, result: { thread: { id: 'tool-thread' } } });
  } else if (request.method === 'turn/start') {
    send({ id: request.id, result: { turn: { id: 'tool-turn' } } });
    send({ method: 'item/started', params: { threadId: 'tool-thread', turnId: 'tool-turn', item: { id: 'tool-1', type: 'commandExecution', command: 'long-running' } } });
    setTimeout(() => {
      send({ method: 'item/completed', params: { threadId: 'tool-thread', turnId: 'tool-turn', item: { id: 'tool-1', type: 'commandExecution', aggregatedOutput: 'done' } } });
      send({ method: 'item/completed', params: { threadId: 'tool-thread', turnId: 'tool-turn', item: { id: 'reply-1', type: 'agentMessage', text: 'completed after the tool' } } });
      send({ method: 'turn/completed', params: { threadId: 'tool-thread', turn: { id: 'tool-turn', status: 'completed' } } });
    }, 120);
  }
});`);
    const result = provider.queryStream((async function* (): AsyncGenerator<UserInput> {
      yield { role: 'user', content: 'run the long tool' };
    })(), { sessionKey: 'active-tool', settingSources: [] } as AgentQueryOptions);
    const messages: AgentMessage[] = [];
    try {
      for await (const message of result.iterator) { messages.push(message); }
      expect(messages).toContainEqual(expect.objectContaining({ type: 'text', content: 'completed after the tool' }));
      expect(messages.some(message => message.metadata?.terminatedReason === 'stall')).toBe(false);
      expect(messages.filter(message => message.type === 'error')).toEqual([]);
    } finally { provider.dispose(); }
  });

  it('emits one terminal stall result instead of replacing the session', async () => {
    const { provider, dir } = providerFixture('exit 0', 'app-server', { DISCLAUDE_STALL_TIMEOUT_MS: '30' });
    writeFileSync(join(dir, 'bin', 'codex'), `#!${process.execPath}
const readline = require('node:readline');
const send = message => console.log(JSON.stringify(message));
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ id: request.id, result: {} });
  else if (request.method === 'thread/start' || request.method === 'thread/resume') {
    send({ id: request.id, result: { thread: { id: 'stall-thread' } } });
  } else if (request.method === 'turn/start') {
    send({ id: request.id, result: { turn: { id: 'stall-turn' } } });
  } else if (request.method === 'turn/interrupt') {
    send({ id: request.id, result: {} });
  }
});`);
    const result = provider.queryStream((async function* (): AsyncGenerator<UserInput> {
      yield { role: 'user', content: 'hang' };
    })(), { sessionKey: 'true-stall', settingSources: [] } as AgentQueryOptions);
    const messages: AgentMessage[] = [];
    try {
      for await (const message of result.iterator) { messages.push(message); }
      const stallResults = messages.filter(message => message.metadata?.terminatedReason === 'stall');
      expect(stallResults).toHaveLength(1);
      expect(stallResults[0]?.content).toContain('Codex 控制通道无响应');
      expect(stallResults[0]?.metadata?.terminationDetail).toContain('thread/read control probe timed out after 30ms');
      expect(stallResults[0]?.metadata?.terminationDetail).toContain('stall-turn');
      expect(messages.filter(message => message.type === 'error')).toEqual([]);
    } finally { provider.dispose(); }
  });

  it.each(['active', 'unavailable'])('preserves a quiet model wait with %s runtime status', async status => {
    const { provider, dir } = providerFixture('exit 0', 'app-server', { DISCLAUDE_STALL_TIMEOUT_MS: '50' });
    writeFileSync(join(dir, 'bin', 'codex'), `#!${process.execPath}
const fs=require('node:fs');const send=m=>console.log(JSON.stringify(m));let probes=0,starts=0;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'quiet-thread'}}});
 else if(m.method==='turn/start'){
  fs.writeFileSync(process.env.CODEX_HOME+'/starts',String(++starts));send({id:m.id,result:{turn:{id:'quiet-turn'}}});
  send({method:'item/reasoning/textDelta',params:{threadId:'quiet-thread',turnId:'quiet-turn',delta:'owned thinking'}});
  setTimeout(()=>{send({method:'item/completed',params:{threadId:'quiet-thread',turnId:'quiet-turn',item:{id:'final',type:'agentMessage',text:'quiet wait completed'}}});send({method:'turn/completed',params:{threadId:'quiet-thread',turn:{id:'quiet-turn',status:'completed'}}});},350);
 } else if(m.method==='thread/read'){
  fs.writeFileSync(process.env.CODEX_HOME+'/probe',JSON.stringify({...m.params,count:++probes}));
  send({id:m.id,result:{thread:{id:'quiet-thread',status:${status === 'active' ? "{type:'active',activeFlags:[]}" : 'undefined'}}}});
 }
});`);
    const onActivity = vi.fn(() => { throw new Error('owned observer failure'); });
    const stream = provider.queryStream((async function* (): AsyncGenerator<UserInput> {
      yield { role: 'user', content: 'owned quiet wait' };
    })(), { sessionKey: 'quiet-model', settingSources: [], onActivity } as AgentQueryOptions);
    const messages: AgentMessage[] = [];
    try {
      for await (const message of stream.iterator) { messages.push(message); }
      expect(messages).toContainEqual(expect.objectContaining({ type: 'text', content: 'quiet wait completed' }));
      expect(messages.some(m => m.metadata?.terminatedReason === 'stall')).toBe(false);
      expect(onActivity).toHaveBeenCalledWith('codex:app-server:item/reasoning/textDelta');
      const probe = JSON.parse(readFileSync(join(dir, 'home/probe'), 'utf8'));
      expect(probe).toMatchObject({ threadId: 'quiet-thread', includeTurns: false });
      expect(probe.count).toBeGreaterThanOrEqual(2);
      expect(readFileSync(join(dir, 'home/starts'), 'utf8')).toBe('1');
    } finally { provider.dispose(); }
  });

  it('settles a process exit during an open tool as one correlated stall without replay', async () => {
    const { provider, dir } = providerFixture('exit 0', 'app-server');
    writeFileSync(join(dir, 'bin', 'codex'), `#!${process.execPath}
const fs=require('node:fs');const send=m=>console.log(JSON.stringify(m));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'dead-thread'}}});
 else if(m.method==='turn/start'){
  fs.writeFileSync(process.env.CODEX_HOME+'/started','once');send({id:m.id,result:{turn:{id:'dead-turn'}}});
  send({method:'item/started',params:{threadId:'dead-thread',turnId:'dead-turn',item:{id:'tool',type:'commandExecution',command:'owned tool'}}});
  setTimeout(()=>process.exit(7),50);
 }
});`);
    const correlation = { runId: 'original-run', chatId: 'original-chat', sourceMessageId: 'original-source', traceId: 'original-trace' };
    const stream = provider.queryStream((async function* (): AsyncGenerator<UserInput> {
      yield { role: 'user', content: 'owned process exit', correlation };
    })(), { sessionKey: 'dead-model', settingSources: [] } as AgentQueryOptions);
    const messages: AgentMessage[] = [];
    try {
      for await (const message of stream.iterator) { messages.push(message); }
      const terminal = messages.filter(m => m.type === 'result');
      expect(terminal).toHaveLength(1);
      expect(terminal[0]?.metadata?.terminatedReason).toBe('stall');
      expect(terminal[0]?.metadata?.terminationDetail).toContain('exited (code=7');
      for (const value of Object.values(correlation)) { expect(terminal[0]?.metadata?.terminationDetail).toContain(value); }
      expect(readFileSync(join(dir, 'home/started'), 'utf8')).toBe('once');
      expect(messages.some(m => m.content.includes('Session replaced'))).toBe(false);
    } finally { provider.dispose(); }
  });

  it('uses the same registry manifest as exec for app-server turns', async () => {
    const { provider, dir } = providerFixture('exit 0');
    const workspace = mkdtempSync(join(tmpdir(), 'codex-app-skills-'));
    dirs.push(workspace);
    mkdirSync(join(workspace, 'skills', 'demo'), { recursive: true });
    writeFileSync(join(workspace, 'skills', 'demo', 'SKILL.md'), '---\ndescription: Demo skill\n---');
    for (const [directory, name, description] of [
      ['.disclaude', 'shared-local', 'Shared local skill'],
      ['.claude', 'claude-local', 'Claude local skill'],
    ]) {
      const root = join(workspace, directory, 'skills', name);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'SKILL.md'), `---\ndescription: ${description}\n---`);
    }
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
    expect(prompt).toContain('skills/shared-local/SKILL.md');
    expect(prompt).toContain('Shared local skill');
    expect(prompt).not.toContain('claude-local');
    expect(prompt).not.toContain('Claude local skill');
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
echo '{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","item":{"id":"progress","type":"agentMessage","text":"Still waiting","phase":"commentary"}}}'
echo '{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","item":{"id":"item-1","type":"agentMessage","text":"hello","phase":"final_answer"}}}'
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
    expect(messages).toContainEqual(expect.objectContaining({ type: 'text', content: 'hello', metadata: expect.objectContaining({ phase: 'final_answer' }) }));
    expect(messages).toContainEqual(expect.objectContaining({ type: 'text', content: 'Still waiting', metadata: expect.objectContaining({ phase: 'commentary' }) }));
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
    const terminal = messages.find((message) => message.type === 'result');
    expect(terminal?.metadata?.terminatedReason).toBe('stall');
    expect(terminal?.metadata?.terminationDetail).toContain('exited (code=7');
    provider.dispose();
  });

  it.each(['interrupted', 'cancelled'])('marks backend %s as an interrupted outcome', async status => {
    const { provider } = providerFixture(`
read initialize; echo '{"id":1,"result":{}}'
read initialized
read thread; echo '{"id":2,"result":{"thread":{"id":"thread-1"}}}'
read start; echo '{"id":3,"result":{"turn":{"id":"turn-1"}}}'
echo '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"${status}"}}}'
`);
    const result = provider.queryStream((async function* () {
      yield { role: 'user', content: 'first' } as UserInput;
    })(), { sessionKey: 'chat-stop', settingSources: [] } as AgentQueryOptions);
    const messages: AgentMessage[] = [];
    for await (const message of result.iterator) {
      messages.push(message);
    }
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'result', content: '⏹️ Codex turn interrupted', metadata: { terminatedReason: 'interrupted' },
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

  it('treats a stop after turn/completed as benign teardown, not a no-active-turn error (#5186)', async () => {
    const { provider, dir } = providerFixture('exit 0');
    // SIGTERM holds teardown open so the test's close() deterministically lands
    // while the per-turn finalizer is still awaiting lifecycle.close().
    writeFileSync(join(dir, 'bin', 'codex'), `#!${process.execPath}
require('node:fs').writeFileSync(process.env.CODEX_HOME + '/sigterm', 'pending');
process.on('SIGTERM', () => {
  require('node:fs').writeFileSync(process.env.CODEX_HOME + '/sigterm', 'seen');
  setTimeout(() => process.exit(0), 250);
});
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') console.log(JSON.stringify({ id: request.id, result: {} }));
  else if (request.method === 'thread/start' || request.method === 'thread/resume') {
    console.log(JSON.stringify({ id: request.id, result: { thread: { id: 'race-thread' } } }));
  } else if (request.method === 'turn/start') {
    console.log(JSON.stringify({ id: request.id, result: { turn: { id: 'race-turn' } } }));
    console.log(JSON.stringify({ method: 'turn/completed', params: { threadId: 'race-thread', turn: { id: 'race-turn', status: 'completed' } } }));
  } else if (request.method === 'turn/interrupt') {
    require('node:fs').writeFileSync(process.env.CODEX_HOME + '/interrupted', 'unexpected');
    console.log(JSON.stringify({ id: request.id, result: {} }));
  }
});
`);
    const result = provider.queryStream((async function* () {
      yield { role: 'user', content: 'finish quickly' } as UserInput;
    })(), { sessionKey: 'post-terminal-stop', settingSources: [] } as AgentQueryOptions);
    const messages: AgentMessage[] = [];
    try {
      for await (const message of result.iterator) {
        messages.push(message);
        if (message.type === 'result' && message.content === '✅ Complete') {
          // Task-reset semantics (#5186): ChatAgent.reset() closes the handle
          // right after the completed result, while teardown is still pending.
          result.handle.close();
        }
      }
      expect(messages.some(m => m.type === 'error')).toBe(false);
      expect(readFileSync(join(dir, 'home/sigterm'), 'utf8')).toBe('seen');
      // The lifecycle guard rejects locally without an RPC; assert the server
      // never saw an interrupt request either.
      expect(() => readFileSync(join(dir, 'home/interrupted'), 'utf8')).toThrow();
    } finally { provider.dispose(); }
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
