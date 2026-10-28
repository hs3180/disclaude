import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
it.each(['complete', 'parent-ended', 'stop', 'denied', 'cancel-admission'])(
  'binds background model tools to actual originating input through %s', scenario => {
    const directory = mkdtempSync(join(tmpdir(), 'disclaude-background-tools-'));
    try {
      const config = join(directory, 'config.json');
      writeFileSync(config, JSON.stringify({ workspace: { dir: directory },
        agents: { default: { backend: 'claude', llm: 'default' } },
        llms: { default: { model: 'offline', api: { protocol: 'anthropic', apiKey: '$TEST_LLM_DEFAULT_KEY' } } } }));
      const script = `
        import assert from 'node:assert/strict';
        import { realpathSync, appendFileSync, readFileSync, mkdirSync } from 'node:fs';
        import { join } from 'node:path';
        import { Config, ProjectManager, TaskResultOutbox, getProvider } from './packages/core/dist/index.js';
        import { prepareTools } from './packages/core/dist/sdk/tools.js';
        import { AgentTaskService } from './packages/service/dist/agents/agent-task-service.js';
        import { BackgroundAgentTasks } from './packages/service/dist/agents/background-agent-tasks.js';
        import { BackgroundTaskTools } from './packages/service/dist/agents/background-task-tools.js';
        import { registerFeishuInputSource, getIncomingInputSource, bindVerifiedInputContext } from './packages/service/dist/agents/input-provenance.js';
        globalThis.fetch = async () => { throw new Error('Live fetch forbidden'); };
        const root = realpathSync(${JSON.stringify(directory)}), scenario = ${JSON.stringify(scenario)};
        const child = join(root, 'child'), other = join(root, 'other'); mkdirSync(child); mkdirSync(other);
        const manager = new ProjectManager({ workspaceDir: root }); manager.use('chat', root);
        const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
        const entered = gate(), work = gate(), authEntered = gate(), authRelease = gate();
        let queries = 0, closes = 0, wakes = 0, lastHandle; let allowed = scenario !== 'denied';
        const callbacks = { sendMessage: async () => 'local-only', sendFile: async () => {}, sendCard: async () => {} };
        const authorization = new AgentTaskService({ projectManager: manager, isAllowed: () => allowed,
          runtimeOptions: () => Config.getAgentConfig(), callbacks: () => callbacks });
        const outbox = new TaskResultOutbox(join(root, 'reports'));
        const tasks = new BackgroundAgentTasks({ outbox, callbacks: () => callbacks, runtimeOptions: () => Config.getAgentConfig(),
          authorize: async () => { if (scenario === 'cancel-admission') { authEntered.release(); await authRelease.promise; } if (!allowed) throw new Error('denied'); },
          wakeParent: async () => { wakes++; return 'host-admission'; } });
        const originalStart = tasks.start.bind(tasks);
        tasks.start = async (...args) => { lastHandle = await originalStart(...args); return lastHandle; };
        const definitions = new BackgroundTaskTools({ authorization, tasks, outbox });
        for (const options of [{ cwd: root }, { codexRuntime: { transport: 'app-server' } }, { cwd: root, codexRuntime: { transport: 'exec' } }]) {
          assert.equal(definitions.configureQueryOptions(options), options);
        }
        const configured = definitions.configureQueryOptions({ cwd: root, codexRuntime: { transport: 'app-server' }, tools: [authorization.createTool(root)] });
        const tools = prepareTools(configured.tools);
        assert.deepEqual(tools.map(tool => tool.name), ['run_agent_task', 'start_agent_task', 'get_agent_task', 'stop_agent_task']);
        const start = tools.find(tool => tool.name === 'start_agent_task'), get = tools.find(tool => tool.name === 'get_agent_task'), stop = tools.find(tool => tool.name === 'stop_agent_task');
        const source = (user = 'actor', topic = 'topic', message = 'source-file') => {
          const incoming = { messageId: message, chatId: 'chat', userId: user, content: 'task', messageType: 'file', metadata: { threadRootId: topic, chatType: 'topic' } };
          registerFeishuInputSource(incoming, message.replace('-file', ''), 'user');
          return bindVerifiedInputContext({ chatId: 'chat', actorId: user, sourceMessageId: message, threadRootId: topic, replyRootId: topic }, getIncomingInputSource(incoming));
        };
        const origin = source(), controller = new AbortController(), context = { inputContext: origin, signal: controller.signal };
        const args = { operationId: 'one', task: 'write once', workingDirectory: 'child' };
        getProvider('claude').queryStream = (input, options) => {
          queries++; const closed = gate();
          return { handle: { close: () => { closes++; closed.release(); }, cancel: () => {} }, iterator: (async function* () {
            const received = (await input.next()).value;
            assert.equal(received.inputContext.sourceMessageId, 'source'); assert.equal(received.inputContext.actorId, 'actor'); assert.equal(options.cwd, child);
            appendFileSync(join(child, 'effect.txt'), 'one\\n');
            await prepareTools(options.tools).find(tool => tool.name === 'agent_task_report').execute({ summary: 'one file', artifacts: ['child/effect.txt'] }, { signal: new AbortController().signal });
            entered.release(); await work.promise;
            yield { type: 'text', role: 'assistant', content: 'done' }; yield { type: 'result', content: '', metadata: { stopReason: 'end_turn' } };
            await closed.promise;
          })() };
        };
        try {
          for (const fake of [undefined, JSON.parse(JSON.stringify(origin)), { ...origin, actorId: 'forged' }]) {
            await assert.rejects(start.execute(args, { ...context, inputContext: fake }));
          }
          await assert.rejects(start.execute({ ...args, actorId: 'forged' }, context)); assert.equal(queries, 0);
          if (scenario === 'denied') { await assert.rejects(start.execute(args, context), /authorized/); assert.equal(queries, 0); }
          else if (scenario === 'cancel-admission') {
            const outcome = start.execute(args, context).then(() => 'unexpected', error => error.message);
            await authEntered.promise; controller.abort(); authRelease.release();
            assert.match(await outcome, /stopped|abort/i); assert.equal(queries, 0); assert.equal(tasks.isBusy('chat'), false);
          } else {
            const receipt = await start.execute(args, context), initial = lastHandle;
            assert.equal(receipt.state, 'accepted'); await entered.promise;
            assert.equal((await get.execute({ id: receipt.id }, context)).state, 'running');
            const duplicate = await start.execute(args, context); assert.equal(duplicate.id, receipt.id); assert.equal(queries, 1);
            for (const foreign of [source('other-actor'), source('actor', 'other-topic')]) {
              const current = { ...context, inputContext: foreign };
              assert.equal((await get.execute({ id: receipt.id }, current)).state, 'unknown');
              assert.equal((await stop.execute({ id: receipt.id }, current)).stopRequested, false);
            }
            manager.use('chat', other); await assert.rejects(get.execute({ id: receipt.id }, context), /Project/); manager.use('chat', root);
            if (scenario === 'stop') assert.equal((await stop.execute({ id: receipt.id }, context)).stopRequested, true);
            if (scenario === 'parent-ended') controller.abort();
            assert.equal(tasks.isBusy('chat'), true); work.release(); await initial.completion;
            const fresh = { inputContext: source('actor', 'topic', 'new-user-source'), signal: new AbortController().signal };
            const record = await get.execute({ id: receipt.id }, fresh);
            assert.equal(record.state, 'saved'); assert.equal(record.outcome, scenario === 'stop' ? 'stopped' : 'succeeded');
            assert.equal(wakes, scenario === 'stop' ? 0 : 1); assert.equal(readFileSync(join(child, 'effect.txt'), 'utf8'), 'one\\n');
            assert.equal((await stop.execute({ id: receipt.id }, fresh)).stopRequested, false);
          }
          console.log('background-task-tools: passed');
        } finally { work.release(); authRelease.release(); await tasks.close(); await authorization.close(); }
        assert.equal(closes, queries);
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: repo, env: { ...process.env, TEST_LLM_DEFAULT_KEY: 'offline-key', ['DIS' + 'CLAUDE_CONFIG_PATH']: config,
          ['DIS' + 'CLAUDE_WORKSPACE_DIR']: directory, NODE_ENV: 'test', LOG_LEVEL: 'error', LOG_TO_FILE: 'false' }, encoding: 'utf8', timeout: 15_000,
      });
      expect(result.signal, result.stderr || result.stdout).toBeNull();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('background-task-tools: passed');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
