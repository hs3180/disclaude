import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
it.each(['stop', 'close', 'stop-delivery-fails', 'rpc-stop', 'rpc-close', 'normal'])(
  'retains native query and delivery ownership through %s', scenario => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-task-delivery-'));
    try {
      const config = join(root, 'config.json');
      writeFileSync(config, JSON.stringify({ workspace: { dir: root },
        agents: { default: { backend: 'claude', llm: 'default' } },
        llms: { default: { model: 'offline-task-delivery', api: { protocol: 'anthropic', apiKey: '$TEST_LLM_DEFAULT_KEY' } } },
      }));
      const script = `
        import assert from 'node:assert/strict';
        import { realpathSync } from 'node:fs';
        import { getProvider } from './packages/core/dist/index.js';
        import { AgentTaskRunner } from './packages/service/dist/agents/agent-task-runner.js';
        globalThis.fetch = async () => { throw new Error('Live fetch forbidden'); };
        const scenario = ${JSON.stringify(scenario)}, root = realpathSync(${JSON.stringify(root)});
        const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
        const delivering = gate(), delivery = gate();
        let queries = 0, closed = 0, exited = 0, completed = false, callbackSettled = false, rpcEntered = false;
        const rpc = scenario.startsWith('rpc-');
        getProvider('claude').queryStream = (input, options) => {
          queries++; const parked = gate();
          return { handle: { close: () => { closed++; parked.release(); }, cancel: () => {} },
            iterator: (async function* () {
              try {
                const item = (await input.next()).value;
                if (rpc) {
                  void options.onUserInput({ kind: 'rpc', requestId: 'fixture-question', threadId: 'native-thread', turnId: 'native-turn', itemId: 'q',
                    isBlocking: true, signal: new AbortController().signal,
                    questions: [{ id: 'q', header: 'Choice', question: 'Choose', isOther: true, isSecret: false, options: null }], respond: async () => {},
                  }, item.inputContext).catch(() => {});
                  await parked.promise; return;
                }
                yield { type: 'text', role: 'assistant', content: 'owned result' };
                yield { type: 'result', content: '', metadata: { stopReason: 'end_turn' } };
                await parked.promise;
              } finally { exited++; }
            })() };
        };
        const runner = new AgentTaskRunner();
        const handle = runner.start({ task: 'deliver', workingDirectory: root, chatId: 'actual-chat',
          senderOpenId: 'actual-actor', sourceMessageId: 'actual-source', threadRootId: 'actual-topic' }, {
          sendMessage: async (chat, text, topic) => {
            assert.equal(chat, 'actual-chat'); assert.equal(topic, 'actual-topic');
            delivering.release();
            try { await delivery.promise; if (scenario === 'stop-delivery-fails') throw new Error('offline delivery failure'); return 'fixture-receipt'; }
            finally { callbackSettled = true; }
          }, sendCard: async () => {}, sendFile: async () => {},
          requestAgentInput: async () => {
            rpcEntered = true; delivering.release();
            try { await delivery.promise; } finally { callbackSettled = true; }
          },
        });
        const outcome = handle.completion.then(result => { completed = true; return result; });
        try {
          await delivering.promise;
          if (rpc) assert.equal(rpcEntered, true);
          let closing;
          if (scenario === 'close' || scenario === 'rpc-close') closing = runner.close();
          else if (scenario !== 'normal') handle.stop();
          for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
          assert.equal(callbackSettled, false); assert.equal(completed, false);
          assert.equal(runner.activeCount, 1, 'Pending callback lost its execution owner');
          delivery.release();
          const result = await outcome;
          assert.equal(result.outcome, scenario === 'normal' ? 'succeeded' : 'stopped');
          assert.equal(callbackSettled, true); assert.equal(exited, 1);
          assert.equal(runner.activeCount, 0); assert.equal(queries, 1); assert.equal(closed, 1);
          await closing; await runner.close();
          console.log('task-cancel-delivery: passed');
        } finally { delivery.release(); await runner.close(); }
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: repo, env: { ...process.env, TEST_LLM_DEFAULT_KEY: 'offline-key',
          ['DIS' + 'CLAUDE_CONFIG_PATH']: config, ['DIS' + 'CLAUDE_WORKSPACE_DIR']: root,
          LOG_LEVEL: 'error', LOG_TO_FILE: 'false', NODE_ENV: 'test',
        }, encoding: 'utf8', timeout: 10_000,
      });
      expect(result.signal, result.stderr || result.stdout).toBeNull();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('task-cancel-delivery: passed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
