import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
it.each(['user', 'push', 'busy'])(
  'routes the actual pool and native task ports for %s input', scenario => {
    const directory = mkdtempSync(join(tmpdir(), 'disclaude-default-task-'));
    try {
      const config = join(directory, 'config.json');
      writeFileSync(config, JSON.stringify({ workspace: { dir: directory },
        agents: { default: { backend: 'codex', llm: 'default', codex: { transport: 'app-server' } } },
        llms: { default: { model: 'gpt-6.1-sol', reasoningEffort: 'max', maxConcurrentSessions: scenario === 'busy' ? 1 : 3 } } }));
      const script = `
        import assert from 'node:assert/strict';
        import { realpathSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
        import { join } from 'node:path';
        import { Config, ProjectManager, getProvider } from './packages/core/dist/index.js';
        import { prepareTools } from './packages/core/dist/sdk/tools.js';
        import { AgentTaskService } from './packages/service/dist/agents/agent-task-service.js';
        import { ChatSessionPool } from './packages/service/dist/chat-session-pool.js';
        import { registerFeishuInputSource, getIncomingInputSource } from './packages/service/dist/agents/input-provenance.js';
        globalThis.fetch = async () => { throw new Error('Live fetch forbidden'); };
        const root = realpathSync(${JSON.stringify(directory)}), scenario = ${JSON.stringify(scenario)};
        const manager = new ProjectManager({ workspaceDir: root });
        const sends = []; let native = 0, children = 0, closed = 0, tasks;
        const callbacks = { sendMessage: async (chat, text, topic) => { sends.push({ chat, text, topic }); return 'local-only'; },
          sendFile: async () => {}, sendCard: async () => {} };
        const pool = new ChatSessionPool({ cwdProvider: () => root, cwdResolver: () => manager.resolveCwd('actual-chat'),
          configureQueryOptions: (options, chat) => { assert.equal(chat, 'actual-chat'); return tasks.configureQueryOptions(options); } });
        tasks = new AgentTaskService({ projectManager: manager, runtimeOptions: () => Config.getAgentConfig(),
          callbacks: () => callbacks, isAllowed: facts => facts.chatId === 'actual-chat' && facts.actorId === 'actual-user' && facts.chatType === 'topic' });
        assert.deepEqual(tasks.configureQueryOptions({ cwd: root }).tools, undefined);
        assert.deepEqual(tasks.configureQueryOptions({ cwd: root, codexRuntime: { transport: 'exec' } }).tools, undefined);
        const provider = getProvider('codex'); provider.managesLlmSessionLimit = () => false;
        provider.validateConfig = () => true; provider.getInfo = () => ({ name: 'codex', version: 'offline-port', available: true });
        provider.queryStream = (input, options) => {
          native++; const child = options.sessionKey.includes('task:'); if (child) children++;
          let release; const exited = new Promise(resolve => { release = resolve; });
          return { handle: { close: () => { closed++; release(); }, cancel: () => {} }, iterator: (async function* () {
            const received = (await input.next()).value;
            assert.equal(received.inputContext.actorId, 'actual-user'); assert.equal(options.cwd, root);
            if (child) {
              assert.equal(options.capacityAdmission, 'reject'); assert.equal(options.tools?.some(tool => tool.name === 'run_agent_task') ?? false, false);
              appendFileSync(join(root, 'child.txt'), 'one write\\n');
            } else {
              const tool = prepareTools(options.tools).find(tool => tool.name === 'run_agent_task'); assert.ok(tool);
              const args = { operationId: 'one-write', task: 'write one artifact', workingDirectory: '.' };
              const context = { inputContext: received.inputContext, signal: new AbortController().signal };
              if (scenario === 'push') await assert.rejects(tool.execute(args, context), /verified originating/);
              else {
                const [first, repeat] = await Promise.all([tool.execute(args, context), tool.execute(args, context)]);
                assert.equal(first.id, repeat.id);
                if (scenario === 'busy') { assert.equal(first.outcome, 'failed'); assert.match(first.error, /busy/i); }
                else assert.equal(first.outcome, 'succeeded');
              }
            }
            yield { type: 'text', role: 'assistant', content: child ? 'child result' : 'parent done' };
            yield { type: 'result', content: '', metadata: { stopReason: 'end_turn' } };
            await exited;
          })() };
        };
        const incoming = { messageId: 'actual-source', chatId: 'actual-chat', userId: 'actual-user',
          messageType: 'text', content: 'perform the subtask', metadata: { threadRootId: 'actual-topic', chatType: 'topic' } };
        registerFeishuInputSource(incoming, incoming.messageId, 'user');
        try {
          const agent = pool.getOrCreateChatAgent('actual-chat', callbacks, 'actual-topic');
          await agent.processMessage({ chatId: 'actual-chat', senderOpenId: 'actual-user', messageId: 'actual-source',
            threadRootId: 'actual-topic', chatType: 'topic', payload: incoming.content,
            ...(scenario === 'push' ? {} : { runtimeSource: getIncomingInputSource(incoming) }) });
          await agent.turnCompleteFor('actual-source'); await agent.waitForWorkSettlement();
          assert.equal(children, scenario === 'user' ? 1 : 0);
          assert.equal(existsSync(join(root, 'child.txt')), scenario === 'user');
          if (scenario === 'user') assert.equal(readFileSync(join(root, 'child.txt'), 'utf8'), 'one write\\n');
          assert.equal(tasks.isBusy('actual-chat'), false); assert.ok(sends.some(send => send.text === 'parent done'));
          assert.ok(sends.every(send => send.chat === 'actual-chat' && send.topic === 'actual-topic'));
        } finally { await tasks.close(); pool.reset('actual-chat', false, 'actual-topic'); }
        assert.equal(closed, native); console.log('default-agent-tasks: passed');
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: repo, env: { ...process.env, ['DIS' + 'CLAUDE_CONFIG_PATH']: config,
          ['DIS' + 'CLAUDE_WORKSPACE_DIR']: directory, NODE_ENV: 'test', LOG_LEVEL: 'error', LOG_TO_FILE: 'false' },
        encoding: 'utf8', timeout: 15_000,
      });
      expect(result.signal, result.stderr || result.stdout).toBeNull();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('default-agent-tasks: passed');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
