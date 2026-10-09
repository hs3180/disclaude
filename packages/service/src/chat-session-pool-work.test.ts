import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

describe('idle reclamation across real ChatAgent work boundaries', () => {
  it.each(['history', 'tool', 'background', 'legacy-background', 'queued', 'stall'])('protects %s work using the actual pool and agent', (scenario) => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-pool-work-'));
    try {
      const configPath = join(root, 'config.json');
      writeFileSync(configPath, JSON.stringify({ workspace: { dir: root },
        agent: { agentBackend: 'claude', provider: 'anthropic', model: 'test-model' }, anthropic: { apiKey: 'test-key' } }));
      const script = `
        import assert from 'node:assert/strict';
        import { getProvider } from './packages/core/dist/index.js';
        import { ChatSessionPool } from './packages/service/dist/chat-session-pool.js';
        const scenario = ${JSON.stringify(scenario)};
        const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
        const first = defer(), next = defer(), history = defer(), done = defer(), finishing = defer();
        const parked = defer();
        let closed = 0, doneCount = 0;
        const output = [], stopNotices = [];
        const sdk = getProvider('claude');
        sdk.queryStream = () => ({
          handle: { close: () => { closed++; parked.resolve(); next.resolve(); }, cancel: () => { parked.resolve(); } },
          iterator: (async function* () {
            await first.promise;
            if (scenario === 'background') {
              yield { type: 'text', role: 'system', content: '', metadata: { backgroundTaskIds: ['research-1'] } };
              // A bookend must not override the full live-task snapshot.
              yield { type: 'text', role: 'system', content: '', metadata: { backgroundTask: { id: 'research-1', state: 'completed' } } };
            } else if (scenario === 'legacy-background') {
              yield { type: 'text', role: 'system', content: '', metadata: { backgroundTask: { id: 'research-1', state: 'running' } } };
            }
            yield { type: 'text', content: 'first-final', role: 'assistant' };
            if (scenario === 'tool') {
              yield { type: 'tool_use', content: '', role: 'assistant', metadata: { toolName: 'Bash' } };
              finishing.resolve(); await next.promise;
              yield { type: 'tool_result', content: '', role: 'tool', metadata: { toolName: 'Bash' } };
            }
            if (scenario === 'queued' || scenario === 'stall') { finishing.resolve(); await next.promise; }
            yield { type: 'result', content: '', metadata: { stopReason: 'end_turn' } };
            if (scenario === 'background') {
              await next.promise;
              yield { type: 'text', role: 'system', content: '', metadata: { backgroundTaskIds: [] } };
            } else if (scenario === 'legacy-background') {
              await next.promise;
              yield { type: 'text', role: 'system', content: '', metadata: { backgroundTask: { id: 'research-1', state: 'completed' } } };
            } else if (scenario === 'queued') {
              yield { type: 'text', content: 'second-final', role: 'assistant' };
              yield { type: 'result', content: '', metadata: { stopReason: 'end_turn' } };
            }
            await parked.promise;
          })(),
        });
        const callbacks = {
          sendMessage: async (_chat, text) => { output.push(text); return 'owned-receipt'; },
          sendCard: async () => {}, sendFile: async () => {},
          ...(scenario === 'history' ? { getChatHistory: () => history.promise } : {}),
          onDone: async () => {
            doneCount++;
            if (scenario === 'queued' && doneCount === 1) { done.resolve(); await history.promise; }
            else { done.resolve(); }
          },
        };
        const pool = new ChatSessionPool({ idleTimeoutMs: 1000, busyTurnHardCapMs: 0,
          onBusyCapExceeded: (_chat, _minutes, decision) => { stopNotices.push(decision); } });
        const agent = pool.getOrCreateChatAgent('owned-chat', callbacks, 'owned-root');
        try {
          const admitted = agent.processMessage({ chatId: 'owned-chat', payload: 'first', messageId: 'first-source', threadRootId: 'owned-root' });
          if (scenario === 'history') {
            await new Promise(r => setImmediate(r));
            assert.equal(agent.isBusy, false);
            assert.deepEqual(pool.evictIdleAgents(Date.now() + 1500), []);
            assert.equal(closed, 0);
            history.resolve(undefined);
          }
          await admitted;
          first.resolve();
          if (scenario === 'queued') {
            await finishing.promise;
            await agent.processMessage({ chatId: 'owned-chat', payload: 'second', messageId: 'second-source', threadRootId: 'owned-root' });
            next.resolve();
          } else if (scenario === 'stall') {
            await finishing.promise;
            const original = agent.pendingWorkContext;
            assert.equal(original.sourceMessageId, 'first-source');
            assert.equal(typeof original.runId, 'string');
            const sweepAt = Date.now() + 30 * 60_000;
            assert.deepEqual(pool.evictIdleAgents(sweepAt), []);
            assert.deepEqual(pool.evictIdleAgents(sweepAt + 60_000), []);
            assert.equal(closed, 1);
            assert.equal(stopNotices.length, 1);
            assert.equal(stopNotices[0].kind, 'no-progress');
            assert.equal(stopNotices[0].runId, original.runId);
            assert.equal(stopNotices[0].sourceMessageId, 'first-source');
            assert.equal(stopNotices[0].traceId, original.traceId);
            assert.equal(stopNotices[0].threadRootId, 'owned-root');
          } else if (scenario === 'tool') {
            await finishing.promise;
            assert.equal(agent.isBusy, true);
            for (const delta of [1500, 2500, 3500]) {
              assert.deepEqual(pool.evictIdleAgents(Date.now() + delta), []);
              assert.equal(pool.get('owned-chat', 'owned-root'), agent);
              assert.equal(pool.getPoolStats().busy, 1);
              assert.equal(closed, 0);
              assert.equal(stopNotices.length, 0);
            }
            next.resolve();
          }
          await done.promise;
          if (scenario !== 'history' && scenario !== 'stall' && scenario !== 'tool') {
            assert.equal(agent.isBusy, false);
            assert.deepEqual(pool.evictIdleAgents(Date.now() + 1500), []);
            assert.equal(closed, 0);
            if (scenario === 'background' || scenario === 'legacy-background') {
              assert.equal(agent.activeBackgroundTaskCount, 1);
              next.resolve();
            }
            else { history.resolve(); }
            for (let i = 0; i < 5; i++) { await new Promise(r => setImmediate(r)); }
          }
          assert.equal(output.filter(text => text === 'first-final').length, 1);
          if (scenario === 'queued') { assert.equal(output.filter(text => text === 'second-final').length, 1); }
          for (let i = 0; i < 5; i++) { await new Promise(r => setImmediate(r)); }
          assert.deepEqual(pool.evictIdleAgents(Date.now() + 1500), ['owned-chat::owned-root']);
          assert.equal(closed, 1);
          console.log('protected-until-complete-and-reclaimed: passed');
        } finally {
          history.resolve(); first.resolve(); next.resolve(); parked.resolve(); pool.disposeAll();
        }
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: repo, env: { ...process.env, DISCLAUDE_CONFIG_PATH: configPath, DISCLAUDE_WORKSPACE_DIR: root, LOG_LEVEL: 'error', LOG_TO_FILE: 'false', NODE_ENV: 'test' },
        encoding: 'utf8', timeout: 10_000,
      });
      expect(result.stderr).toBe('');
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('protected-until-complete-and-reclaimed: passed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
