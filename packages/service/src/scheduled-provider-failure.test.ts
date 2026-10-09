import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

describe('scheduled provider failure through the real agent and routing boundary', () => {
  it.each(['stall', 'turn_failed'])('retains the %s cause and generated identities without replaying partial work', reason => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-scheduled-failure-'));
    try {
      const home = join(root, 'codex-home');
      mkdirSync(home);
      writeFileSync(join(home, 'auth.json'), '{}');
      const config = join(root, 'config.json');
      writeFileSync(config, JSON.stringify({ workspace: { dir: root },
        agent: { agentBackend: 'codex', codex: { model: 'gpt-6-luna' } } }));
      const script = `
        import assert from 'node:assert/strict';
        import { getProvider, setDefaultProvider, MessageRouter, Scheduler } from './packages/core/dist/index.js';
        import { ChatSessionPool } from './packages/service/dist/chat-session-pool.js';
        import { AgentPoolMessageHandler } from './packages/service/dist/messaging/agent-pool-handler.js';
        const output = [];
        let starts = 0, sideEffects = 0, correlation;
        setDefaultProvider('codex');
        getProvider('codex').queryStream = input => ({
          handle: { close() {}, cancel() {} },
          iterator: (async function* () {
            const next = await input.next();
            correlation = next.value.correlation;
            starts++; sideEffects++;
            yield { type: 'text', role: 'assistant', content: 'owned partial result' };
            yield { type: 'result', role: 'system', content: 'owned interruption notice', metadata: {
              terminatedReason: ${JSON.stringify(reason)}, terminationDetail: 'codex app-server: owned provider failure; native-turn=owned-turn',
            } };
          })(),
        });
        const callbacks = { sendMessage: async (_chat, text) => { output.push(text); return 'owned-delivery'; },
          sendCard: async () => {}, sendFile: async () => {}, onDone: async () => {} };
        const pool = new ChatSessionPool();
        const userAgent = pool.getOrCreateChatAgent('owned-chat', callbacks);
        const handler = new AgentPoolMessageHandler({ agentPool: pool, callbacksFactory: () => callbacks });
        const router = new MessageRouter({ handler });
        const task = { id: 'owned-task', name: 'Owned scheduled failure', cron: '0 0 1 1 *',
          prompt: 'owned fixture; no inference', chatId: 'owned-chat', enabled: true, createdAt: new Date().toISOString() };
        const scheduler = new Scheduler({ scheduleManager: { get: async () => task },
          inputMessageRouter: router, callbacks: { sendMessage: callbacks.sendMessage } });
        try {
          await scheduler.executeTask(task);
          assert.equal(starts, 1, 'the controlled SDK iterator must be used');
          const failures = output.filter(text => text.startsWith('❌ 定时任务'));
          assert.equal(failures.length, 1);
          assert.ok(failures[0].includes('owned provider failure'));
          assert.ok(failures[0].includes('native-turn=owned-turn'));
          assert.equal(typeof correlation.runId, 'string');
          assert.equal(typeof correlation.traceId, 'string');
          for (const key of ['runId', 'traceId', 'sourceMessageId']) { assert.ok(failures[0].includes(correlation[key]), key); }
          assert.equal(output.filter(text => text === 'owned partial result').length, 1);
          assert.equal(starts, 1); assert.equal(sideEffects, 1);
          assert.equal(pool.get('owned-chat'), userAgent);
          assert.ok(!output.some(text => text.includes('Session replaced')));
          console.log('original-provider-cause-and-identities: passed');
        } finally { scheduler.stop(); pool.disposeAll(); }
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: repo, env: { ...process.env, DISCLAUDE_CONFIG_PATH: config,
          DISCLAUDE_WORKSPACE_DIR: root, CODEX_HOME: home, CODEX_MODEL: 'gpt-6-luna',
          LOG_LEVEL: 'fatal', LOG_TO_FILE: 'false', NODE_ENV: 'test' },
        encoding: 'utf8', timeout: 15_000,
      });
      expect(result.stderr).toBe('');
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('original-provider-cause-and-identities: passed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
