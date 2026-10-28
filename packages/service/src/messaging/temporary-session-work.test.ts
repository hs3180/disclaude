import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));

it.each(['callbacks', 'background', 'snapshot', 'reset', 'stop', 'dispose', 'iterator-failure', 'continuation-failure'])(
  'temporary execution retains its real work owner through %s', scenario => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-temporary-work-'));
    try {
      const configPath = join(root, 'config.json');
      writeFileSync(configPath, JSON.stringify({ workspace: { dir: root },
        agents: { default: { backend: 'claude', llm: 'default' } },
        llms: { default: { model: 'offline-fixture', api: { protocol: 'anthropic', apiKey: '$TEST_LLM_DEFAULT_KEY' } } },
      }));
      const script = `
        import assert from 'node:assert/strict';
        import { getProvider } from './packages/core/dist/index.js';
        import { ChatSessionPool } from './packages/service/dist/chat-session-pool.js';
        import { AgentPoolMessageHandler } from './packages/service/dist/messaging/agent-pool-handler.js';
        globalThis.fetch = async () => { throw new Error('Live fetch forbidden'); };
        const scenario = ${JSON.stringify(scenario)};
        const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
        const started = defer(), parent = defer(), finish = defer(), continuation = defer(), parked = defer(), callback = defer();
        let closed = 0, finished = false, failure, doneCount = 0;
        const indicators = new Set(); let backgroundIndicators = 0;
        const output = [], anchors = [];
        getProvider('claude').queryStream = () => ({
          handle: { close: () => { closed++; parked.resolve(); finish.resolve(); continuation.resolve(); callback.resolve(); }, cancel: () => {} },
          iterator: (async function* () {
            await started.promise;
            if (scenario !== 'callbacks') {
              yield { type: 'status', content: '', metadata: scenario === 'snapshot'
                ? { backgroundTaskIds: ['child'] } : { backgroundTask: { id: 'child', state: 'running' } } };
            }
            yield { type: 'text', role: 'assistant', content: 'parent-output' };
            yield { type: 'result', content: '', metadata: { stopReason: 'end_turn' } };
            parent.resolve();
            await finish.promise;
            if (scenario === 'iterator-failure') { throw new Error('native child transport lost'); }
            if (scenario !== 'callbacks') {
              yield { type: 'status', content: '', metadata: scenario === 'snapshot'
                ? { backgroundTaskIds: [] } : { backgroundTask: { id: 'child', state: 'completed' } } };
              await continuation.promise;
              yield { type: 'text', role: 'assistant', content: 'child-completion-output' };
              yield { type: 'result', content: '', metadata: scenario === 'continuation-failure'
                ? { terminatedReason: 'turn_failed', terminationDetail: 'offline child failed' } : { stopReason: 'end_turn' } };
            }
            await parked.promise;
          })(),
        });
        const pool = new ChatSessionPool({ idleTimeoutMs: 1000 });
        const handler = new AgentPoolMessageHandler({ agentPool: pool, callbacksFactory: () => ({
          beginProcessing: (_chat, id) => {
            const lease = Symbol(id); indicators.add(lease);
            if (id.startsWith('native-background:')) backgroundIndicators++;
            return () => { indicators.delete(lease); };
          },
          sendMessage: async (_chat, text, anchor) => { output.push(text); anchors.push(anchor); return 'offline-receipt'; },
          sendFile: async () => {}, sendCard: async () => {},
          onDone: async () => { doneCount++; if (scenario === 'callbacks') { parent.resolve(); await callback.promise; } },
        }) });
        const task = handler.handleSystemMessage('owned-chat', 'owned task', 'owned-source', {
          waitForCompletion: true, agentSession: { id: 'execution:owned', skipHistory: true, releaseAfterTurn: true },
          replyRootId: 'actual-topic',
        }).then(() => { finished = true; }, error => { finished = true; failure = error; });
        try {
          const agent = pool.get('owned-chat', 'execution:owned');
          assert.ok(agent); started.resolve(); await parent.promise;
          for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
          assert.equal(finished, false, 'Parent result must not finish the temporary execution');
          assert.equal(closed, 0, 'Native background/callback work must retain the query');
          assert.equal(pool.get('owned-chat', 'execution:owned'), agent);
          assert.equal(indicators.size, scenario === 'callbacks' ? 0 : 1, 'Reported native work retains its background indicator after the input settles');
          assert.deepEqual(pool.evictIdleAgents(Date.now() + 5000), []);
          if (scenario === 'reset') { agent.reset(); }
          else if (scenario === 'stop') { agent.stop(); }
          else if (scenario === 'dispose') { agent.dispose(); }
          else if (scenario === 'callbacks') { callback.resolve(); }
          else {
            finish.resolve();
            if (scenario !== 'iterator-failure') {
              for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
              assert.equal(finished, false, 'A task-completion bookend is not its resumed parent turn');
              assert.equal(closed, 0);
              assert.deepEqual(pool.evictIdleAgents(Date.now() + 5000), []);
              continuation.resolve();
            }
          }
          await task;
          assert.equal(pool.get('owned-chat', 'execution:owned'), undefined);
          if (['reset', 'stop', 'dispose', 'iterator-failure', 'continuation-failure'].includes(scenario)) { assert.ok(failure, 'Interrupted work must not become success'); }
          else {
            assert.equal(failure, undefined);
            if (scenario !== 'callbacks') {
              assert.equal(output.filter(t => t === 'child-completion-output').length, 1);
              assert.equal(doneCount, 2);
            }
          }
          assert.equal(anchors[output.indexOf('parent-output')], 'actual-topic');
          if (output.includes('child-completion-output')) { assert.equal(anchors[output.indexOf('child-completion-output')], 'actual-topic'); }
          assert.equal(closed, 1);
          assert.equal(indicators.size, 0, 'Settled/interrupted work releases both input and background indicators');
          assert.equal(backgroundIndicators, scenario === 'callbacks' ? 0 : 1);
          console.log('owned-work-settled: passed');
        } finally {
          started.resolve(); finish.resolve(); continuation.resolve(); parked.resolve(); callback.resolve();
          pool.disposeAll(); await task;
        }
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: repo, env: { ...process.env, TEST_LLM_DEFAULT_KEY: 'offline-key',
          DISCLAUDE_CONFIG_PATH: configPath, DISCLAUDE_WORKSPACE_DIR: root,
          LOG_LEVEL: 'error', LOG_TO_FILE: 'false', NODE_ENV: 'test' },
        encoding: 'utf8', timeout: 10_000,
      });
      expect(result.stderr).toBe('');
      expect(result.signal).toBeNull();
      expect(result.status, result.stdout).toBe(0);
      expect(result.stdout).toContain('owned-work-settled: passed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
);
