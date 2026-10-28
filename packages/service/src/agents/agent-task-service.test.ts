import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
it.each(['retry', 'denied', 'project-changed', 'revoked', 'abort-delivery', 'close-delivery', 'different-input', 'direct-route'])(
  'admits and owns native subtask work through %s', scenario => {
    const directory = mkdtempSync(join(tmpdir(), 'disclaude-managed-task-'));
    try {
      const config = join(directory, 'config.json');
      writeFileSync(config, JSON.stringify({ workspace: { dir: directory },
        agents: { default: { backend: 'claude', llm: 'default' } },
        llms: { default: { model: 'offline', api: { protocol: 'anthropic', apiKey: '$TEST_LLM_DEFAULT_KEY' } } } }));
      const script = `
        import assert from 'node:assert/strict';
        import { realpathSync, appendFileSync, readFileSync, mkdirSync } from 'node:fs';
        import { join } from 'node:path';
        import { ProjectManager, getProvider } from './packages/core/dist/index.js';
        import { AgentTaskService } from './packages/service/dist/agents/agent-task-service.js';
        import { registerFeishuInputSource, getIncomingInputSource, bindVerifiedInputContext } from './packages/service/dist/agents/input-provenance.js';
        globalThis.fetch = async () => { throw new Error('Live fetch forbidden'); };
        const root = realpathSync(${JSON.stringify(directory)}), scenario = ${JSON.stringify(scenario)};
        const project = join(root, 'project'), other = join(root, 'other'); mkdirSync(project); mkdirSync(other);
        const manager = new ProjectManager({ workspaceDir: root }); manager.use('actual-chat', project);
        const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
        const delivery = gate(), entered = gate(); let queries = 0, closed = 0, selected = 0, allowed = scenario !== 'denied';
        const inputs = [], sends = [], direct = scenario === 'direct-route';
        getProvider('claude').queryStream = (input, options) => {
          const exited = gate(); queries++;
          assert.equal(options.cwd, project); assert.equal(options.model, 'fixed-child');
          assert.equal(options.onAsyncUserInputAnswer, undefined);
          return { handle: { close: () => { closed++; exited.release(); }, cancel: () => {} },
            iterator: (async function* () {
              const received = (await input.next()).value; inputs.push(received.inputContext);
              appendFileSync(join(project, 'effects.txt'), received.inputContext.sourceMessageId + '\\n');
              if (scenario === 'revoked') allowed = false;
              yield { type: 'text', role: 'assistant', content: 'child result' };
              yield { type: 'result', content: '', metadata: { stopReason: 'end_turn' } };
              await exited.promise;
            })() };
        };
        const source = (messageId = 'actual-input-file') => {
          const message = { messageId, chatId: 'actual-chat', userId: 'actual-user', content: 'task', messageType: 'text', metadata: direct ? {} : { threadRootId: 'actual-topic' } };
          registerFeishuInputSource(message, messageId.replace('-file', ''), 'user');
          return Object.freeze({ ...bindVerifiedInputContext({ chatId: message.chatId, actorId: message.userId,
            sourceMessageId: messageId, ...(direct ? { replyRootId: null } : { threadRootId: 'actual-topic', replyRootId: 'actual-topic' }) }, getIncomingInputSource(message)) });
        };
        const origin = source();
        const service = new AgentTaskService({ projectManager: manager, isAllowed: facts => {
          assert.equal(facts.actorId, 'actual-user'); assert.equal(facts.chatId, 'actual-chat'); return allowed;
        }, runtimeOptions: () => { selected++; return { model: 'fixed-child', configureQueryOptions: options => ({ ...options,
          onAsyncUserInputAnswer: async () => { throw new Error('Finite child must not retain an async answer callback'); } }) }; }, callbacks: context => ({
          sendMessage: async (chat, text, topic) => {
            assert.equal(context.replyRootId, direct ? null : 'actual-topic'); sends.push({ chat, text, topic });
            if (['abort-delivery', 'close-delivery'].includes(scenario)) { entered.release(); await delivery.promise; }
            return 'local-receipt';
          }, sendFile: async () => {}, sendCard: async () => {},
        }) });
        const args = { operationId: 'write-one', task: 'write once', workingDirectory: '.' };
        const signal = new AbortController();
        const context = { inputContext: origin, signal: signal.signal };
        const firstTool = service.createTool(project);
        try {
          for (const fake of [undefined, JSON.parse(JSON.stringify(origin)), { ...origin, actorId: 'forged' }, { ...origin, chatId: 'foreign-chat' }]) {
            await assert.rejects(firstTool.execute(args, { signal: signal.signal, inputContext: fake }), /input|originating/);
          }
          assert.equal(queries, 0); assert.equal(selected, 0);
          if (scenario === 'project-changed') manager.use('actual-chat', other);
          if (['denied', 'project-changed'].includes(scenario)) {
            await assert.rejects(firstTool.execute(args, context), /authorized|Project/);
            assert.equal(queries, 0); assert.equal(selected, 0);
          } else if (scenario === 'revoked') {
            await assert.rejects(firstTool.execute(args, context), /authorized/);
            assert.equal(queries, 1); assert.equal(readFileSync(join(project, 'effects.txt'), 'utf8'), 'actual-input\\n');
            allowed = true;
            const retry = await service.createTool(project).execute(args, context);
            assert.equal(retry.outcome, 'succeeded'); assert.equal(queries, 1);
          } else if (['abort-delivery', 'close-delivery'].includes(scenario)) {
            const outcome = firstTool.execute(args, context).then(result => ({ result }), error => ({ error }));
            let done = false; const observed = outcome.then(result => { done = true; return result; });
            await entered.promise;
            let closing, fullyClosed = false;
            if (scenario === 'close-delivery') { closing = service.close(); closing.then(() => { fullyClosed = true; }); }
            else signal.abort();
            for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
            assert.equal(service.isBusy('actual-chat'), true); assert.equal(done, false); assert.equal(fullyClosed, false);
            delivery.release(); const result = await observed; await closing;
            if (scenario === 'close-delivery') assert.match(result.error.message, /closing/);
            else assert.equal(result.result.outcome, 'stopped');
            assert.equal(service.isBusy('actual-chat'), false);
          } else {
            const [first, retry] = await Promise.all([firstTool.execute(args, context), service.createTool(project).execute(args, context)]);
            assert.equal(first.id, retry.id); assert.equal(first.outcome, 'succeeded'); assert.equal(queries, 1);
            await assert.rejects(firstTool.execute({ ...args, task: 'different work' }, context), /different work/);
            await assert.rejects(firstTool.execute(args, { ...context, inputContext: { ...origin, replyRootId: 'changed-target' } }), /reply route/);
            if (scenario === 'different-input') {
              const second = await firstTool.execute(args, { ...context, inputContext: source('another-input-file') });
              assert.notEqual(second.id, first.id); assert.equal(queries, 2); assert.equal(selected, 2);
            }
          }
          assert.ok(inputs.every(input => input.chatId === 'actual-chat' && input.actorId === 'actual-user' &&
            input.threadRootId === (direct ? undefined : 'actual-topic') && input.replyRootId === (direct ? null : 'actual-topic')));
          assert.ok(sends.every(send => send.chat === 'actual-chat' && send.topic === (direct ? undefined : 'actual-topic')));
          assert.equal(closed, queries); console.log('managed-task: passed');
        } finally { delivery.release(); await service.close(); }
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: repo, env: { ...process.env, TEST_LLM_DEFAULT_KEY: 'offline-key',
          ['DIS' + 'CLAUDE_CONFIG_PATH']: config, ['DIS' + 'CLAUDE_WORKSPACE_DIR']: directory,
          NODE_ENV: 'test', LOG_LEVEL: 'error', LOG_TO_FILE: 'false' }, encoding: 'utf8', timeout: 15_000,
      });
      expect(result.signal, result.stderr || result.stdout).toBeNull();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('managed-task: passed');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
