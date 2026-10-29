import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentQueryOptions, ToolDefinition, ToolContext, UserInput } from '../../types.js';
import { CodexAgentProvider } from './provider.js';
import type { AgentInputRequest, AgentInputContext } from '../../user-input.js';
import { LiveInputRejectedError } from '../../live-input.js';

// #5467: sessions without interactive-answer wiring get this appended to each
// turn prompt so the model asks in plain text instead of an async question.
const asyncNote = '\n\n[Session note] This conversation cannot receive asynchronous question forms. When you need clarification, ask the user directly in your reply text instead of using an async question tool.';

const dirs: string[] = [];
function providerFixture(
  body: string,
  transport: 'exec' | 'app-server' | undefined = 'app-server',
  extraEnv: Record<string, string> = {},
  providerOptions: Partial<ConstructorParameters<typeof CodexAgentProvider>[0]> = {},
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
      ...providerOptions,
    }),
  };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('CodexAgentProvider app-server transport', () => {
  it.each(['native', 'legacy', 'rejected', 'timeout', 'lost-ack'] as const)('loads existing skill directories before native start/resume (%s)', async mode => {
    const { provider, dir } = providerFixture('exit 0', 'app-server', {}, { requestTimeoutMs: 5_000 });
    const project = join(dir, 'project'), nested = join(project, 'nested');
    for (const [root, name] of [[dir, 'builtin-probe'], [project, 'project-probe'], [join(project, '.disclaude'), 'managed-probe']]) {
      mkdirSync(join(root, 'skills', name), { recursive: true });
      writeFileSync(join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Native path probe.\n---\nRead references/marker.txt.\n`);
    }
    mkdirSync(nested);
    writeFileSync(join(dir, 'bin', 'codex'), `#!${process.execPath}
const fs=require('node:fs');const send=m=>console.log(JSON.stringify(m));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(process.env.CODEX_HOME+'/methods',JSON.stringify(m)+'\\n');
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='skills/extraRoots/set'){
  const mode=${JSON.stringify(mode)};
  if(mode==='lost-ack')process.exit(7);
  else if(mode==='timeout'){}
  else if(mode==='legacy'||mode==='rejected')send({id:m.id,error:{code:mode==='legacy'?-32601:-32603,message:'injected registration refusal'}});
  else send({id:m.id,result:{}});
 } else if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:'native-skill-thread'}}});
 else if(m.method==='turn/start'){
  send({id:m.id,result:{turn:{id:'native-skill-turn'}}});
  send({method:'item/completed',params:{threadId:'native-skill-thread',turnId:'native-skill-turn',item:{id:'reply',type:'agentMessage',text:'Skill-aware turn finished'}}});
  send({method:'turn/completed',params:{threadId:'native-skill-thread',turn:{id:'native-skill-turn',status:'completed'}}});
 }
});`);
    const success = mode === 'native';
    const stream = provider.queryStream((async function* (): AsyncGenerator<UserInput> {
      yield { role: 'user', content: 'first input' };
      if (success) { yield { role: 'user', content: 'second input' }; }
    })(), { sessionKey: 'native-skills', settingSources: [], projectRoot: project, cwd: nested });
    const messages: AgentMessage[] = [];
    try {
      for await (const message of stream.iterator) { messages.push(message); }
      const calls = readFileSync(join(dir, 'home/methods'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(calls.find(call => call.method === 'initialize').params.capabilities).toEqual({ experimentalApi: true });
      const registrations = calls.filter(call => call.method === 'skills/extraRoots/set');
      expect(registrations).toHaveLength(success ? 2 : 1);
      for (const call of registrations) { expect(call.params.extraRoots).toEqual([join(project, 'skills'), join(project, '.disclaude', 'skills'), join(dir, 'skills')]); }
      const threads = calls.filter(call => call.method.startsWith('thread/'));
      const starts = calls.filter(call => call.method === 'turn/start');
      if (success) {
        expect(threads.map(call => call.method)).toEqual(['thread/start', 'thread/resume']);
        expect(calls.map(call => call.method)).toEqual(['initialize', 'initialized', 'skills/extraRoots/set', 'thread/start', 'turn/start',
          'initialize', 'initialized', 'skills/extraRoots/set', 'thread/resume', 'turn/start']);
        expect(starts).toHaveLength(2);
        for (const call of starts) {
          const prompt = call.params.input[0].text;
          expect(prompt).not.toContain('Disclaude skills:'); expect(prompt).not.toContain('SKILL.md');
        }
        expect(messages.filter(message => message.type === 'result')).toHaveLength(2);
        expect(messages.some(message => message.metadata?.terminatedReason)).toBe(false);
      } else {
        expect(threads).toHaveLength(0); expect(starts).toHaveLength(0);
        expect(messages.some(message => message.type === 'error')).toBe(true);
        expect(messages.some(message => message.type === 'result')).toBe(false);
        if (mode === 'legacy') {
          expect(messages.find(message => message.type === 'error')?.content).toContain('Update Codex CLI');
        }
        if (mode === 'timeout') {
          expect(messages.find(message => message.type === 'error')?.metadata?.error).toMatchObject({
            kind: 'CodexAppServerRequestTimeoutError', method: 'skills/extraRoots/set', timeoutMs: 5_000,
          });
        }
      }
      expect(calls.some(call => /plugin\/(install|reconcile)|config\/.*write/.test(call.method))).toBe(false);
    } finally { stream.handle.close(); provider.dispose(); }
  }, 20_000);

  it.each([-32600, -32601, -32602, -32603, 'lost-ack', 'mismatched-ack'] as const)('maps live-input RPC outcomes through the provider-neutral contract (%s)', async code => {
    const { provider, dir } = providerFixture('exit 0');
    writeFileSync(join(dir, 'bin', 'codex'), `#!${process.execPath}
const fs=require('node:fs');const send=m=>console.log(JSON.stringify(m));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'owned-thread'}}});
 else if(m.method==='turn/start'){fs.appendFileSync(process.env.CODEX_HOME+'/writes','start\\n');send({id:m.id,result:{turn:{id:'owned-turn'}}});}
 else if(m.method==='turn/steer'){
  fs.appendFileSync(process.env.CODEX_HOME+'/writes','steer\\n');
  const mode=${JSON.stringify(code)};
  if(mode==='lost-ack')process.exit(7);
  else if(mode==='mismatched-ack')send({id:m.id,result:{turnId:'other-turn'}});
  else send({id:m.id,error:{code:mode,message:'Owned RPC rejection'}});
 }
 else if(m.method==='turn/interrupt'){send({id:m.id,result:{}});send({method:'turn/completed',params:{threadId:'owned-thread',turn:{id:'owned-turn',status:'interrupted'}}});}
});`);
    const stream = provider.queryStream((async function* () { yield { role: 'user', content: 'owned input' } as UserInput; })(), {
      sessionKey: 'rejection-contract', settingSources: [],
    });
    const collecting = (async () => { for await (const _message of stream.iterator) { /* drain */ } })();
    try {
      await vi.waitFor(() => expect((provider as any).appServerLifecycles.get('rejection-contract')?.snapshot('rejection-contract')?.activeTurnId).toBe('owned-turn'));
      const error = await stream.handle.steer!('owned correction').catch(error => error);
      if (typeof code === 'string' || code === -32603) {
        expect(error).not.toBeInstanceOf(LiveInputRejectedError);
        expect(error).toBeInstanceOf(Error);
        if (code === -32603) { expect(error).toMatchObject({ name: 'CodexAppServerRpcError', code }); }
        if (code === 'mismatched-ack') { expect(error.message).toContain('did not match'); }
      } else {
        expect(error).toBeInstanceOf(LiveInputRejectedError);
        expect(error.cause).toMatchObject({ name: 'CodexAppServerRpcError', code });
      }
      expect(readFileSync(join(dir, 'home/writes'), 'utf8')).toBe('start\nsteer\n');
    } finally { stream.handle.cancel(); await collecting; provider.dispose(); }
  });

  it('maps completed-turn preflight through the provider-neutral contract without sending a control request', async () => {
    const { provider, dir } = providerFixture('exit 0');
    writeFileSync(join(dir, 'bin', 'codex'), `#!${process.execPath}
const fs=require('node:fs');const send=m=>console.log(JSON.stringify(m));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(process.env.CODEX_HOME+'/requests',m.method+'\\n');
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'finished-thread'}}});
 else if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'finished-turn'}}});send({method:'turn/completed',params:{threadId:'finished-thread',turn:{id:'finished-turn',status:'completed'}}});}
});`);
    const stream = provider.queryStream((async function* () { yield { role: 'user', content: 'owned input' } as UserInput; })(), {
      sessionKey: 'finished-contract', settingSources: [],
    });
    try {
      for await (const _message of stream.iterator) { /* drain */ }
      const error = await stream.handle.steer!('late correction').catch(error => error);
      expect(error).toBeInstanceOf(LiveInputRejectedError);
      expect(error.cause).toMatchObject({ name: 'CodexNoActiveTurnError', operation: 'steer' });
      expect(readFileSync(join(dir, 'home/requests'), 'utf8')).not.toContain('turn/steer');
    } finally { stream.handle.close(); provider.dispose(); }
  });

  it.each(['active', 'lost-ack', 'unsupported'] as const)('handles native async answers without replay (%s)', async mode => {
    const { provider, dir } = providerFixture('exit 0');
    writeFileSync(join(dir, 'bin', 'codex'), `#!${process.execPath}
const fs=require('node:fs');const send=m=>console.log(JSON.stringify(m));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'async-thread'}}});
 else if(m.method==='turn/start'){
  fs.appendFileSync(process.env.CODEX_HOME+'/writes','start\\n');
  send({id:m.id,result:{turn:{id:'async-turn'}}});
  send({method:'item/completed',params:{threadId:'async-thread',turnId:'async-turn',item:{id:'question',type:'agentMessage',text:'Which scope?',delivery:'async',questions:[{title:'Which scope?'}]}}});
  if(${JSON.stringify(mode)}==='unsupported')send({method:'turn/completed',params:{threadId:'async-thread',turn:{id:'async-turn',status:'completed'}}});
 } else if(m.method==='turn/steer'){
  fs.appendFileSync(process.env.CODEX_HOME+'/writes','steer\\n');
  if(${JSON.stringify(mode)}==='lost-ack'){process.exit(1);return;}
  send({id:m.id,result:{turnId:'async-turn'}});
  send({method:'turn/completed',params:{threadId:'async-thread',turn:{id:'async-turn',status:'completed'}}});
 }
});`);
    const onUserInput = vi.fn<(request: AgentInputRequest) => Promise<void>>().mockResolvedValue();
    const onAsyncUserInputAnswer = vi.fn().mockResolvedValue(undefined);
    const stream = provider.queryStream((async function* (): AsyncGenerator<UserInput> {
      yield { role: 'user', content: 'Original task', inputContext: { actorId: 'owner', chatId: 'chat', sourceMessageId: 'source' } };
    })(), { sessionKey: `async-${mode}`, settingSources: [], onUserInput,
      ...(mode === 'unsupported' ? {} : { onAsyncUserInputAnswer }),
    });
    const messages: AgentMessage[] = [];
    const collecting = (async () => { for await (const message of stream.iterator) { messages.push(message); } })();
    try {
      if (mode === 'unsupported') {
        await collecting;
        expect(onUserInput).not.toHaveBeenCalled();
        // #5467: a capability mismatch degrades to a plain-text question and
        // the turn completes normally; only delivery accidents fail the turn.
        const degraded = messages.find(m => m.type === 'text' && m.content.includes('任务需要你的输入'));
        expect(degraded).toBeDefined();
        expect(degraded?.content).toContain('Which scope?');
        expect(messages.some(m => m.type === 'error')).toBe(false);
        expect(messages.some(m => m.metadata?.terminatedReason === 'turn_failed')).toBe(false);
        expect(readFileSync(join(dir, 'home/writes'), 'utf8')).toBe('start\n');
      } else {
        await vi.waitFor(() => expect(onUserInput).toHaveBeenCalledOnce());
        const [[request]] = onUserInput.mock.calls;
        const response = request.respond({ 'question-1': { answers: ['Original scope'] } });
        if (mode === 'lost-ack') { await expect(response).rejects.toThrow(/delivery failed/); }
        else { await response; }
        await collecting;
        expect(readFileSync(join(dir, 'home/writes'), 'utf8')).toBe('start\nsteer\n');
      }
      expect(onAsyncUserInputAnswer).not.toHaveBeenCalled();
    } finally { stream.handle.close(); await collecting; provider.dispose(); }
  });

  it('delivers an async question before reporting a simultaneous completion and keeps its delayed answer in the originating conversation', async () => {
    const { provider, dir } = providerFixture('exit 0');
    writeFileSync(join(dir, 'bin', 'codex'), `#!${process.execPath}
const send=m=>console.log(JSON.stringify(m));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'async-thread'}}});
 else if(m.method==='turn/start'){
  process.stdout.write(JSON.stringify({id:m.id,result:{turn:{id:'async-turn'}}})+'\\n'+
   JSON.stringify({method:'item/completed',params:{threadId:'async-thread',turnId:'async-turn',item:{id:'async-question',type:'agentMessage',text:'Any constraint?',delivery:'async',questions:[{title:'Any constraint?'}]}}})+'\\n'+
   JSON.stringify({method:'turn/completed',params:{threadId:'async-thread',turn:{id:'async-turn',status:'completed'}}})+'\\n');
  setTimeout(()=>process.exit(0),10);
 }
});`);
    const context = { actorId: 'owner', chatId: 'original-chat', sourceMessageId: 'original-message', threadRootId: 'original-root' };
    let confirmDelivery!: () => void;
    const onUserInput = vi.fn<(request: AgentInputRequest, context: AgentInputContext | undefined) => Promise<void>>()
      .mockImplementation(() => new Promise<void>(resolve => { confirmDelivery = resolve; }));
    const onAsyncUserInputAnswer = vi.fn().mockResolvedValue(undefined);
    let release!: () => void;
    const input = (async function* (): AsyncGenerator<UserInput> {
      yield { role: 'user', content: 'Original task', inputContext: context };
      await new Promise<void>(resolve => { release = resolve; });
    })();
    const stream = provider.queryStream(input, {
      sessionKey: 'async-delayed', settingSources: [], onUserInput, onAsyncUserInputAnswer,
      // The completed turn's sender may still be pending after this short
      // watchdog window and after its owned app-server exits.
      env: { DISCLAUDE_STALL_TIMEOUT_MS: '25' },
    } as AgentQueryOptions);
    const messages: AgentMessage[] = [];
    const collecting = (async () => { for await (const message of stream.iterator) { messages.push(message); } })();
    try {
      await vi.waitFor(() => expect(onUserInput).toHaveBeenCalledOnce());
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(messages.some(m => m.type === 'result')).toBe(false);
      expect(messages.some(m => m.type === 'error')).toBe(false);
      confirmDelivery();
      await vi.waitFor(() => expect(messages.some(m => m.type === 'result')).toBe(true));
      expect(onUserInput).toHaveBeenCalledOnce();
      const [[question, originalContext]] = onUserInput.mock.calls;
      expect(originalContext).toEqual(context);
      expect(question.signal.aborted).toBe(false);
      await new Promise(resolve => setTimeout(resolve, 50));
      await question.respond({ 'question-1': { answers: ['No extensions'] } });
      expect(onAsyncUserInputAnswer).toHaveBeenCalledOnce();
      expect(onAsyncUserInputAnswer.mock.calls[0]).toEqual([
        expect.objectContaining({ threadId: 'async-thread', turnId: 'async-turn', itemId: 'async-question' }),
        'Submitted answers to your questions:\n[{"question":"Any constraint?","answers":["No extensions"]}]', context,
      ]);
      await expect(question.respond({ 'question-1': { answers: ['Again'] } })).rejects.toThrow(/no longer active/);
    } finally { confirmDelivery?.(); release?.(); stream.handle.close(); await collecting; provider.dispose(); }
  });

  it.each(['completed', 'failed', 'interrupted'])('retains async delivery failure and native execution facts (%s)', async nativeStatus => {
    const { provider, dir } = providerFixture('exit 0');
    writeFileSync(join(dir, 'bin', 'codex'), `#!${process.execPath}
const fs=require('node:fs');const send=m=>console.log(JSON.stringify(m));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'async-thread'}}});
 else if(m.method==='turn/start'){
  send({id:m.id,result:{turn:{id:'async-turn'}}});
  send({method:'item/completed',params:{threadId:'async-thread',turnId:'async-turn',item:{id:'async-question',type:'agentMessage',text:'Any constraint?',delivery:'async',questions:[{title:'Any constraint?'}]}}});
  send({method:'item/completed',params:{threadId:'async-thread',turnId:'async-turn',item:{id:'artifact',type:'commandExecution',command:'write-once',aggregatedOutput:'saved',status:'completed'}}});
  send({method:'item/completed',params:{threadId:'async-thread',turnId:'async-turn',item:{id:'final',type:'agentMessage',phase:'final_answer',text:'Artifact is ready.'}}});
  const gate=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(join(dir, 'delivery-attempted'))}))return;clearInterval(gate);send({method:'turn/completed',params:{threadId:'async-thread',turn:{id:'async-turn',status:${JSON.stringify(nativeStatus)},...( ${JSON.stringify(nativeStatus)} === 'failed' ? {error:{message:'native execution failed'}} : {})}}});},5);
 }
});`);
    const onUserInput = vi.fn().mockImplementation(() => {
      writeFileSync(join(dir, 'delivery-attempted'), 'attempted');
      return Promise.reject(new Error('private transport detail'));
    });
    const stream = provider.queryStream((async function* (): AsyncGenerator<UserInput> {
      yield { role: 'user', content: 'Original task', inputContext: { actorId: 'owner', chatId: 'chat', sourceMessageId: 'message' } };
    })(), { sessionKey: 'async-failed', settingSources: [], onUserInput, onAsyncUserInputAnswer: vi.fn() } as AgentQueryOptions);
    const messages: AgentMessage[] = [];
    try {
      for await (const message of stream.iterator) { messages.push(message); }
      expect(onUserInput).toHaveBeenCalledOnce();
      expect(messages.filter(m => m.type === 'text').map(m => m.content)).toContain('Artifact is ready.');
      expect(messages.filter(m => m.type === 'tool_result')).toHaveLength(1);
      expect(messages.filter(m => m.type === 'result')).toEqual([
        expect.objectContaining({ metadata: expect.objectContaining({ terminatedReason: 'turn_failed', inputDeliveryFailure: { nativeCompleted: nativeStatus === 'completed' }, automaticReplayBlocked: 'async-input-delivery-failed' }) }),
      ]);
      expect(messages.map(m => m.content).join('\n')).toContain('Async question');
      if (nativeStatus === 'failed') { expect(messages.find(m => m.type === 'result')?.metadata?.terminationDetail).toContain('native execution failed'); }
      expect(messages.map(m => m.content).join('\n')).not.toContain('private transport detail');
    } finally { provider.dispose(); }
  });

  it('rejects host tools before starting codex exec', () => {
    const { provider } = providerFixture('exit 0', 'exec');
    const tools: ToolDefinition[] = [{ name: 'read_notebook', description: 'Read', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, execute: () => Promise.resolve({}) }];
    const input = (async function* (): AsyncGenerator<UserInput> {
      yield { role: 'user', content: 'Read the notebook' };
    })();
    try {
      expect(() => provider.queryStream(input, {
        sessionKey: 'exec-host-tool', settingSources: [], tools,
      } as AgentQueryOptions)).toThrow('require agents.<name>.codex.transport: app-server');
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
  fs.appendFileSync(process.env.CODEX_HOME+'/turn-inputs',JSON.stringify(m.params.input)+String.fromCharCode(10));
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
      yield { role: 'user', content: 'Record the first marker', continuationContext: 'Stable channel guidance' };
      yield { role: 'user', content: 'Record the second marker', continuationContext: 'Stable channel guidance' };
    })(), {
      sessionKey: 'dynamic-tool-resume', settingSources: [], tools,
    } as AgentQueryOptions);
    const messages: AgentMessage[] = [];
    try {
      for await (const message of result.iterator) { messages.push(message); }
      const threadRequests = readFileSync(join(dir, 'home/methods'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(threadRequests.map(request => request.method)).toEqual(['thread/start', 'thread/resume']);
      const turnInputs = readFileSync(join(dir, 'home/turn-inputs'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(turnInputs[0]).toEqual([{ type: 'text', text: `Stable channel guidance\nRecord the first marker${asyncNote}` }]);
      expect(turnInputs[1]).toEqual([{ type: 'text', text: `Record the second marker${asyncNote}` }]);
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
    // Give the fixture RPC time under coverage; completion depends on two
    // received probes rather than a wall-clock race with the runner.
    const { provider, dir } = providerFixture('exit 0', 'app-server', { DISCLAUDE_STALL_TIMEOUT_MS: '1000' });
    writeFileSync(join(dir, 'bin', 'codex'), `#!${process.execPath}
const fs=require('node:fs');const send=m=>console.log(JSON.stringify(m));let probes=0,starts=0;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'quiet-thread'}}});
 else if(m.method==='turn/start'){
  fs.writeFileSync(process.env.CODEX_HOME+'/starts',String(++starts));send({id:m.id,result:{turn:{id:'quiet-turn'}}});
  send({method:'item/reasoning/textDelta',params:{threadId:'quiet-thread',turnId:'quiet-turn',delta:'owned thinking'}});
 } else if(m.method==='thread/read'){
  fs.writeFileSync(process.env.CODEX_HOME+'/probe',JSON.stringify({...m.params,count:++probes}));
  send({id:m.id,result:{thread:{id:'quiet-thread',status:${status === 'active' ? "{type:'active',activeFlags:[]}" : 'undefined'}}}});
  if(probes===2)setTimeout(()=>{send({method:'item/completed',params:{threadId:'quiet-thread',turnId:'quiet-turn',item:{id:'final',type:'agentMessage',text:'quiet wait completed'}}});send({method:'turn/completed',params:{threadId:'quiet-thread',turn:{id:'quiet-turn',status:'completed'}}});},50);
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

  it('loads shared project directories natively without a repeated prompt manifest', async () => {
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
  if (request.method === 'skills/extraRoots/set') fs.writeFileSync(process.env.CODEX_HOME + '/skill-roots', JSON.stringify(request.params.extraRoots));
  if (request.method === 'turn/start') { fs.writeFileSync(process.env.CODEX_HOME + '/turn-input', request.params.input[0].text); result={turn:{id:'skills-turn'}}; }
  console.log(JSON.stringify({id:request.id,result}));
  if (request.method === 'turn/start') console.log(JSON.stringify({method:'turn/completed',params:{threadId:'skills-thread',turn:{id:'skills-turn',status:'completed'}}}));
});`);
    const stream = provider.queryStream((async function* () { yield { role: 'user', content: 'hello' } as UserInput; })(), {
      sessionKey: 'skills', cwd: workspace, settingSources: [],
    } as AgentQueryOptions);
    for await (const _message of stream.iterator) { /* drain */ }
    const prompt = readFileSync(join(dir, 'home', 'turn-input'), 'utf8');
    expect(JSON.parse(readFileSync(join(dir, 'home', 'skill-roots'), 'utf8'))).toEqual([
      join(workspace, 'skills'), join(workspace, '.disclaude', 'skills'),
    ]);
    expect(prompt).toBe(`hello${asyncNote}`);
    expect(prompt).not.toContain(workspace);
    provider.dispose();
  });

  it('requests no experimental capability and sends no skill registration without skill roots', async () => {
    const { provider, dir } = providerFixture('exit 0');
    writeFileSync(join(dir, 'bin', 'codex'), `#!${process.execPath}
const fs=require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(process.env.CODEX_HOME+'/methods',JSON.stringify(m)+'\\n');
 const send=r=>console.log(JSON.stringify(r));
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'no-skills-thread'}}});
 else if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'no-skills-turn'}}});
  send({method:'item/completed',params:{threadId:'no-skills-thread',turnId:'no-skills-turn',item:{id:'reply',type:'agentMessage',text:'done'}}});
  send({method:'turn/completed',params:{threadId:'no-skills-thread',turn:{id:'no-skills-turn',status:'completed'}}});}
});
`);
    const project = join(dir, 'project');
    mkdirSync(project);
    const stream = provider.queryStream((async function* (): AsyncGenerator<UserInput> {
      yield { role: 'user', content: 'no skills here' };
    })(), { sessionKey: 'no-skills', settingSources: [], projectRoot: project, cwd: project } as AgentQueryOptions);
    try {
      for await (const _message of stream.iterator) { /* drain */ }
      const calls = readFileSync(join(dir, 'home', 'methods'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      // Without any skill directory there is nothing to register; the transport
      // must not opt into the experimental capability on its own.
      expect(calls.find(call => call.method === 'initialize').params.capabilities).toBeNull();
      expect(calls.some(call => call.method === 'skills/extraRoots/set')).toBe(false);
      expect(calls.some(call => call.method?.startsWith?.('thread/'))).toBe(true);
    } finally { stream.handle.close(); provider.dispose(); }
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

  function start(provider: CodexAgentProvider, sessionKey: string, llmSessionLimit?: AgentQueryOptions['llmSessionLimit']) {
    let release!: () => void;
    let send!: (input: UserInput | undefined) => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const followup = new Promise<UserInput | undefined>(resolve => { send = resolve; });
    const result = provider.queryStream((async function* () {
      yield { role: 'user', content: 'hold until steer' } as UserInput;
      const next = await followup;
      if (next) { yield next; }
      await pending;
    })(), { sessionKey, settingSources: [], llmSessionLimit } as AgentQueryOptions);
    const messages: AgentMessage[] = [];
    const collecting = (async () => {
      for await (const message of result.iterator) {messages.push(message);}
    })();
    return { ...result, messages, collecting,
      send: () => send({ role: 'user', content: 'continue the same conversation' } as UserInput),
      release: () => { send(undefined); release(); },
    };
  }
  type Stream = ReturnType<typeof start>;
  const started = (stream: Stream) => vi.waitFor(() => expect(stream.messages.some(m => m.type === 'status')).toBe(true));
  const complete = async (stream: Stream) => {
    const completed = stream.messages.filter(m => m.content === '✅ Complete').length;
    await stream.handle.steer?.('finish');
    await vi.waitFor(() => expect(stream.messages.filter(m => m.content === '✅ Complete')).toHaveLength(completed + 1));
  };

  it('releases completed connections without evicting idle streams and resumes their threads', async () => {
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
      expect(provider.getGovernanceStats().activeSessions).toBe(1);
      const threadId = idle.handle.sessionId;
      const newcomer = start(provider, 'new'); streams.push(newcomer);
      await started(newcomer);
      expect(idle.messages.filter(m => m.type === 'error')).toEqual([]);
      expect(idle.messages.filter(m => m.metadata?.terminatedReason === 'evicted')).toEqual([]);
      expect(active.messages.some(m => m.type === 'result' || m.type === 'error')).toBe(false);
      await complete(active);
      await complete(newcomer);
      await vi.waitFor(() => expect(provider.getGovernanceStats().runningRuns).toBe(0));
      expect(provider.getGovernanceStats().activeSessions).toBe(0);
      idle.send();
      await vi.waitFor(() => expect(idle.messages.filter(m => m.type === 'status')).toHaveLength(2));
      expect(idle.handle.sessionId).toBe(threadId);
      expect(provider.getGovernanceStats().activeSessions).toBe(1);
      await complete(idle);
      await vi.waitFor(() => expect(provider.getGovernanceStats().activeSessions).toBe(0));
      provider.forgetSession('idle');
      const reset = start(provider, 'idle'); streams.push(reset);
      await started(reset);
      expect(reset.handle.sessionId).not.toBe(threadId);
      expect(provider.getGovernanceStats().evictedSessions).toBe(0);
    } finally {
      provider.dispose();
      for (const stream of streams) {stream.release();}
      await Promise.all(streams.map(s => s.collecting));
    }
    expect(provider.getGovernanceStats().activeSessions).toBe(0);
  });

  it.each([
    { maxActiveSessions: 1, maxConcurrentRuns: 2 },
    { maxActiveSessions: 3, maxConcurrentRuns: 1 },
  ])('counts only live connections and cancels queued admission (%j)', async limits => {
    const provider = controlledProvider();
    provider.setGovernanceLimits(limits);
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
      expect(active.messages.some(m => m.metadata?.terminatedReason === 'evicted')).toBe(false);
      expect(provider.getGovernanceStats().activeSessions).toBe(1);
      expect(provider.getGovernanceStats().runningRuns).toBe(1);
      await complete(waiting);
    } finally {
      provider.dispose();
      for (const stream of streams) {stream.release();}
      await Promise.all(streams.map(s => s.collecting));
    }
    expect(provider.getGovernanceStats().activeSessions).toBe(0);
  });

  it('releases the shared named-LLM reservation on delivery and reacquires it for a followup', async () => {
    const provider = controlledProvider();
    provider.setGovernanceLimits({ maxActiveSessions: 3, maxConcurrentRuns: 3 });
    const limit = { name: 'native-connection-budget', maxConcurrentSessions: 1 };
    const streams: Stream[] = [];
    try {
      expect(provider.managesLlmSessionLimit({ settingSources: [] })).toBe(true);
      const a = start(provider, 'named-a', limit); streams.push(a); await started(a);
      const b = start(provider, 'named-b', limit); streams.push(b);
      expect(b.handle.capacityQueued).toBe(true);
      await complete(a); await started(b);
      expect(b.handle.capacityQueued).toBe(false);
      a.send();
      await vi.waitFor(() => expect(a.handle.capacityQueued).toBe(true));
      expect(a.messages.filter(m => m.type === 'status')).toHaveLength(1);
      await complete(b);
      await vi.waitFor(() => expect(a.messages.filter(m => m.type === 'status')).toHaveLength(2));
      await complete(a);
      await vi.waitFor(() => expect(provider.getGovernanceStats().activeSessions).toBe(0));
      expect(provider.getGovernanceStats().evictedSessions).toBe(0);
    } finally {
      provider.dispose(); for (const s of streams) { s.release(); }
      await Promise.all(streams.map(s => s.collecting));
    }
  });
});

describe('Issue #5505: turn/start ACK timeout stays a structured terminal failure', () => {
  it('reports the typed timeout once with method/stage/uncertain state and never replays it', async () => {
    const { provider, dir } = providerFixture('exit 0', 'app-server', {}, { requestTimeoutMs: 1000 });
    writeFileSync(join(dir, 'bin', 'codex'), `#!${process.execPath}
const fs=require('node:fs');const send=m=>console.log(JSON.stringify(m));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'ack-loss-thread'}}});
 else if(m.method==='turn/start'){fs.appendFileSync(process.env.CODEX_HOME+'/writes','turn-start\\n');}
});`);
    const stream = provider.queryStream((async function* () { yield { role: 'user', content: 'read-only status query' } as UserInput; })(), {
      sessionKey: 'ack-loss', settingSources: [],
    });
    const messages: AgentMessage[] = [];
    const collecting = (async () => { for await (const message of stream.iterator) { messages.push(message); } })();
    try {
      await vi.waitFor(() => expect(readFileSync(join(dir, 'home/writes'), 'utf8')).toBe('turn-start\n'), { timeout: 5000 });
      await vi.waitFor(() => expect(messages.some(message => message.type === 'error')).toBe(true), { timeout: 5000 });
      await collecting;
      // One clear terminal failure: the typed error, its RPC method, the
      // stage, the elapsed timeout and the unknown submission state.
      expect(messages.filter(message => message.type === 'error')).toHaveLength(1);
      const [failure] = messages.filter(message => message.type === 'error');
      expect(failure.content).toBe('codex app-server request timed out: turn/start');
      expect(failure.metadata?.error).toMatchObject({
        kind: 'CodexAppServerRequestTimeoutError', method: 'turn/start', stage: 'turn-start',
        timeoutMs: 1000, uncertain: true,
      });
      // The stream ends normally without a result and without throwing; the
      // unacknowledged turn was never retried.
      expect(messages.filter(message => message.type === 'result')).toHaveLength(0);
      expect(readFileSync(join(dir, 'home/writes'), 'utf8')).toBe('turn-start\n');
    } finally { stream.handle.close(); await collecting; provider.dispose(); }
  }, 15_000);

  it('keeps already-delivered turn progress and still fails once when a later turn ACK is lost', async () => {
    const { provider, dir } = providerFixture('exit 0', 'app-server', {}, { requestTimeoutMs: 1000 });
    writeFileSync(join(dir, 'bin', 'codex'), `#!${process.execPath}
const fs=require('node:fs');const send=m=>console.log(JSON.stringify(m));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='thread/start'||m.method==='thread/resume'){send({id:m.id,result:{thread:{id:'late-ack-thread'}}});}
 else if(m.method==='turn/start'){
  fs.appendFileSync(process.env.CODEX_HOME+'/writes','turn-start\\n');
  if(!fs.existsSync(process.env.CODEX_HOME+'/acked')){
   fs.writeFileSync(process.env.CODEX_HOME+'/acked','1');
   send({id:m.id,result:{turn:{id:'late-ack-turn-1'}}});
   send({method:'item/completed',params:{threadId:'late-ack-thread',turnId:'late-ack-turn-1',item:{id:'item-1',type:'agentMessage',text:'First turn delivered'}}});
   send({method:'turn/completed',params:{threadId:'late-ack-thread',turn:{id:'late-ack-turn-1',status:'completed'}}});
  }
  // Second turn/start gets no ACK: the submission state stays unknown.
 }
});`);
    const stream = provider.queryStream((async function* () {
      yield { role: 'user', content: 'first query' } as UserInput;
      yield { role: 'user', content: 'second query' } as UserInput;
    })(), { sessionKey: 'late-ack', settingSources: [] });
    const messages: AgentMessage[] = [];
    const collecting = (async () => { for await (const message of stream.iterator) { messages.push(message); } })();
    try {
      await vi.waitFor(() => expect(readFileSync(join(dir, 'home/writes'), 'utf8')).toBe('turn-start\nturn-start\n'), { timeout: 5000 });
      await vi.waitFor(() => expect(messages.some(message => message.type === 'error')).toBe(true), { timeout: 5000 });
      await collecting;
      // Prior turn progress stays delivered exactly once; the lost-ACK turn
      // contributes one structured failure and no fabricated success.
      expect(messages.filter(message => message.type === 'text' && message.content === 'First turn delivered')).toHaveLength(1);
      expect(messages.filter(message => message.type === 'error')).toHaveLength(1);
      const [failure] = messages.filter(message => message.type === 'error');
      expect(failure.metadata?.error).toMatchObject({
        kind: 'CodexAppServerRequestTimeoutError', method: 'turn/start', uncertain: true,
      });
      // Each submission went out exactly once — no replay of either input.
      expect(readFileSync(join(dir, 'home/writes'), 'utf8')).toBe('turn-start\nturn-start\n');
    } finally { stream.handle.close(); await collecting; provider.dispose(); }
  }, 20_000);
});
