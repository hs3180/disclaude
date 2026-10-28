import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
it.each(['succeeded', 'failed', 'stream-error', 'stop', 'close', 'unknown-ack', 'parent-refused', 'revoked', 'close-auth'])(
  'owns background work and its actual parent report through %s', scenario => {
    const directory = mkdtempSync(join(tmpdir(), 'disclaude-background-'));
    try {
      const config = join(directory, 'config.json');
      writeFileSync(config, JSON.stringify({ workspace: { dir: directory },
        agents: { default: { backend: 'claude', llm: 'default' } },
        llms: { default: { model: 'offline', api: { protocol: 'anthropic', apiKey: '$TEST_LLM_DEFAULT_KEY' } } } }));
      const script = `
        import assert from 'node:assert/strict';
        import { realpathSync, appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
        import { join } from 'node:path';
        import { Config, TaskResultOutbox, getProvider } from './packages/core/dist/index.js';
        import { prepareTools } from './packages/core/dist/sdk/tools.js';
        import { BackgroundAgentTasks } from './packages/service/dist/agents/background-agent-tasks.js';
        import { createTaskParentReporter } from './packages/service/dist/agents/background-task-parent.js';
        import { ChatSessionPool } from './packages/service/dist/chat-session-pool.js';
        globalThis.fetch = async () => { throw new Error('Live fetch forbidden'); };
        const root = realpathSync(${JSON.stringify(directory)}), scenario = ${JSON.stringify(scenario)};
        const childDir = join(root, 'child'); mkdirSync(childDir);
        const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
        const entered = gate(), work = gate(), authEntered = gate(), authRelease = gate();
        const outbox = new TaskResultOutbox(join(root, 'reports'));
        const request = { task: 'make an artifact', workingDirectory: childDir, projectRoot: root,
          chatId: 'actual-chat', senderOpenId: 'actual-user', sourceMessageId: 'actual-source', threadRootId: 'actual-topic', chatType: 'topic' };
        let jobs, handle, parent, queries = 0, children = 0, effects = 0, closes = 0, wakes = 0, nativeFinished = false, allowed = true;
        const callbacks = { sendMessage: async (chat, text, topic) => {
          assert.equal(chat, 'actual-chat');
          assert.equal(topic, scenario === 'parent-refused' && text.startsWith('⚠️ 消息未能送达') ? undefined : 'actual-topic'); return 'local-only';
        }, sendFile: async () => {}, sendCard: async () => {} };
        const pool = new ChatSessionPool({ cwdProvider: () => root });
        const reportParent = createTaskParentReporter(report => pool.getOrCreateChatAgent(report.chatId, callbacks, report.threadRootId));
        jobs = new BackgroundAgentTasks({ outbox, runtimeOptions: () => Config.getAgentConfig(), callbacks: () => callbacks,
          authorize: async source => {
            assert.equal(source.projectRoot, root); assert.equal(source.chatId, 'actual-chat');
            assert.equal(source.senderOpenId, 'actual-user');
            if (scenario === 'close-auth' && nativeFinished) { authEntered.release(); await authRelease.promise; }
            if (!allowed) throw new Error('permission revoked');
          }, wakeParent: async report => {
            wakes++; assert.equal(report.projectRoot, root); assert.equal(report.artifacts[0], 'child/artifact.txt');
            assert.equal((await outbox.get(report.id)).delivery, 'sending');
            const receipt = await reportParent(report);
            if (scenario === 'unknown-ack') throw new Error('parent accepted, acknowledgement lost');
            return receipt;
          } });
        getProvider('claude').queryStream = (input, options) => {
          queries++; const child = options.sessionKey.includes('task:'); if (child) children++;
          const closed = gate();
          return { handle: { close: () => { closes++; closed.release(); }, cancel: () => {} }, iterator: (async function* () {
            if (child) {
              const next = await Promise.race([input.next(), closed.promise.then(() => ({ done: true }))]);
              if (next.done) return;
              assert.equal(options.cwd, childDir); assert.equal(options.capacityAdmission, 'queue'); effects++;
              appendFileSync(join(childDir, 'artifact.txt'), 'one effect\\n');
              const tool = prepareTools(options.tools).find(tool => tool.name === 'agent_task_report');
              await tool.execute({ summary: 'artifact recorded', artifacts: ['child/artifact.txt'] }, { signal: new AbortController().signal });
              entered.release(); await work.promise; nativeFinished = true;
              if (scenario === 'stream-error') throw new Error('injected native stream failure after one effect');
              if (scenario === 'failed') yield { type: 'result', role: 'system', content: '', terminatedReason: 'turn_failed', terminationDetail: 'injected native failure after one effect' };
              else { yield { type: 'text', role: 'assistant', content: 'child done' }; yield { type: 'result', content: '', metadata: { stopReason: 'end_turn' } }; }
              await closed.promise;
            } else {
              let initial = true;
              while (true) {
                const next = await Promise.race([input.next(), closed.promise.then(() => ({ done: true }))]);
                if (next.done) break;
                const received = next.value;
                if (initial) {
                  const [first, repeat] = await Promise.all([jobs.start('one', request), jobs.start('one', { ...request })]);
                  assert.equal(first.id, repeat.id); handle = first; initial = false;
                } else {
                  assert.ok(received.content.includes(handle.id));
                  assert.equal(received.inputContext?.actorId, undefined);
                  appendFileSync(join(root, 'parent.txt'), 'report handled\\n');
                }
                yield { type: 'text', role: 'assistant', content: 'parent turn done' };
                yield { type: 'result', content: '', metadata: { stopReason: 'end_turn' } };
              }
            }
          })() };
        };
        try {
          parent = pool.getOrCreateChatAgent('actual-chat', callbacks, 'actual-topic');
          await parent.processMessage({ chatId: 'actual-chat', messageId: 'actual-source', senderOpenId: 'actual-user',
            threadRootId: 'actual-topic', payload: 'start child then end this turn' });
          await parent.turnCompleteFor('actual-source'); await entered.promise;
          assert.equal(jobs.isBusy('actual-chat'), true); assert.equal(wakes, 0); assert.equal(children, 1);
          let closing, closed = false;
          if (scenario === 'revoked') allowed = false;
          if (scenario === 'stop') {
            assert.equal(jobs.stopForParent('another-chat', 'actual-topic'), false);
            assert.equal(jobs.stopForParent('actual-chat', 'another-topic'), false);
            assert.equal(jobs.stopForParent('actual-chat', 'actual-topic'), true);
          }
          if (scenario === 'parent-refused') parent.channel.push = () => false;
          if (scenario === 'close') { closing = jobs.close(); closing.then(() => { closed = true; }); }
          if (['stop', 'close'].includes(scenario)) {
            for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
            assert.equal(jobs.isBusy('actual-chat'), true); assert.equal(closed, false);
          }
          work.release();
          if (scenario === 'close-auth') {
            await authEntered.promise; closing = jobs.close(); authRelease.release();
          }
          const record = await handle.completion; await closing;
          const attempted = ['succeeded', 'failed', 'stream-error', 'unknown-ack', 'parent-refused'].includes(scenario);
          const notified = attempted && scenario !== 'parent-refused';
          assert.equal(record.delivery, ['unknown-ack', 'parent-refused'].includes(scenario) ? 'uncertain' : notified ? 'delivered' : 'pending');
          assert.equal(record.report.outcome, ['stop', 'close'].includes(scenario) ? 'stopped' : ['failed', 'stream-error'].includes(scenario) ? 'failed' : 'succeeded');
          assert.equal(jobs.isBusy('actual-chat'), false); assert.equal(wakes, attempted ? 1 : 0);
          assert.equal(readFileSync(join(childDir, 'artifact.txt'), 'utf8'), 'one effect\\n');
          if (notified) { await parent.turnCompleteFor('task-report-' + handle.id); assert.equal(readFileSync(join(root, 'parent.txt'), 'utf8'), 'report handled\\n'); }
          else assert.equal(existsSync(join(root, 'parent.txt')), false);
          const queriesBeforeRetry = children;
          allowed = true; const retry = await jobs.start('one', request).catch(error => { if (['close', 'close-auth'].includes(scenario)) return undefined; throw error; });
          if (retry) { assert.equal(retry.id, handle.id); await retry.completion; }
          assert.equal(children, queriesBeforeRetry); assert.equal(effects, 1); assert.equal(wakes, attempted ? 1 : 0);
          console.log('background-agent-tasks: passed');
        } finally { work.release(); authRelease.release(); await jobs.close(); pool.reset('actual-chat', false, 'actual-topic'); await parent?.waitForQueryExit(); }
        assert.equal(closes, queries);
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: repo, env: { ...process.env, TEST_LLM_DEFAULT_KEY: 'offline-key', ['DIS' + 'CLAUDE_CONFIG_PATH']: config,
          ['DIS' + 'CLAUDE_WORKSPACE_DIR']: directory, NODE_ENV: 'test', LOG_LEVEL: 'error', LOG_TO_FILE: 'false' }, encoding: 'utf8', timeout: 15_000,
      });
      expect(result.signal, result.stderr || result.stdout).toBeNull();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('background-agent-tasks: passed');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
