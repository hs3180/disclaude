import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));

it.each(['concurrent', 'cancel-one', 'stop-before-start', 'stop-active', 'close-active', 'background', 'parent-failure-background', 'failure', 'truncated', 'missing-directory'])(
  'runs an explicit independent agent task through %s', scenario => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-agent-task-'));
    try {
      const a = join(root, 'project-a'), b = join(root, 'project-b');
      mkdirSync(a); mkdirSync(b);
      const configPath = join(root, 'config.json');
      writeFileSync(configPath, JSON.stringify({ workspace: { dir: root },
        agents: { default: { backend: 'claude', llm: 'default' } },
        llms: { default: { model: 'offline-fixture', api: { protocol: 'anthropic', apiKey: '$TEST_LLM_DEFAULT_KEY' } } },
      }));
      const script = `
        import assert from 'node:assert/strict';
        import { realpathSync, rmSync } from 'node:fs';
        import { getProvider } from './packages/core/dist/index.js';
        import { AgentTaskRunner } from './packages/service/dist/agents/agent-task-runner.js';
        globalThis.fetch = async () => { throw new Error('Live fetch forbidden'); };
        const scenario = ${JSON.stringify(scenario)}, a = realpathSync(${JSON.stringify(a)}), b = realpathSync(${JSON.stringify(b)});
        const ownsBackground = scenario === 'background' || scenario === 'parent-failure-background';
        const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
        const admitted = defer(), bothAdmitted = defer(), release = defer(), background = defer(), resumed = defer(), parent = defer();
        let admissionCount = 0;
        const calls = [], sends = [], closed = [];
        getProvider('claude').queryStream = (input, options) => {
          const parked = defer(), gate = defer();
          const call = { cwd: options.cwd, sessionKey: options.sessionKey, model: options.model, allow: gate.resolve }; calls.push(call);
          return {
            handle: { close: () => { closed.push(call.sessionKey); gate.resolve(); release.resolve(); background.resolve(); resumed.resolve(); parked.resolve(); }, cancel: () => {} },
            iterator: (async function* () {
              call.input = (await input.next()).value;
              admitted.resolve();
              if (++admissionCount === 2) bothAdmitted.resolve();
              if (scenario === 'cancel-one') await gate.promise;
              if (scenario === 'stop-active' || scenario === 'close-active') await release.promise;
              if (ownsBackground) {
                yield { type: 'status', content: '', metadata: { backgroundTaskIds: ['owned-native-child'] } };
              }
              yield { type: 'text', role: 'assistant', content: scenario === 'truncated' ? 'x'.repeat(66000) : 'result:' + options.cwd };
              yield { type: 'result', content: '', metadata: scenario === 'failure' || scenario === 'parent-failure-background'
                ? { terminatedReason: 'turn_failed', terminationDetail: 'offline failure token=private-fixture-secret' }
                : { stopReason: 'end_turn' } };
              parent.resolve();
              if (ownsBackground) {
                await background.promise;
                yield { type: 'status', content: '', metadata: { backgroundTaskIds: [] } };
                await resumed.promise;
                yield { type: 'text', role: 'assistant', content: 'native-child-summary' };
                yield { type: 'result', content: '', metadata: { stopReason: 'end_turn' } };
              }
              await parked.promise;
            })(),
          };
        };
        const callbacks = { sendMessage: async (chat, text, anchor) => { sends.push({ chat, text, anchor }); return 'offline-receipt'; },
          sendCard: async () => {}, sendFile: async () => {},
          getChatHistory: async () => { throw new Error('Child must not load parent chat history'); } };
        const runner = new AgentTaskRunner();
        const request = { chatId: 'actual-chat', sourceMessageId: 'actual-source', senderOpenId: 'actual-actor',
          threadRootId: 'actual-topic', task: 'owned-task-a', workingDirectory: a };
        try {
          assert.throws(() => runner.start({ ...request, senderOpenId: '' }, callbacks), /trusted source/);
          assert.throws(() => runner.start({ ...request, workingDirectory: 'relative' }, callbacks), /Invalid/);
          assert.equal(calls.length, 0);
          const first = runner.start(request, callbacks);
          request.task = 'mutated'; request.workingDirectory = b;
          assert.equal(runner.activeCount, 1);
          if (scenario === 'stop-before-start') first.stop();
          if (scenario === 'missing-directory') rmSync(a, { recursive: true });
          let second;
          if (scenario === 'concurrent' || scenario === 'cancel-one') second = runner.start({ ...request, task: 'owned-task-b' }, callbacks);
          if (scenario === 'cancel-one') {
            await bothAdmitted.promise;
            let otherFinished = false; second.completion.then(() => { otherFinished = true; });
            first.stop(); await first.completion;
            assert.equal(otherFinished, false); assert.equal(runner.activeCount, 1); assert.equal(closed.length, 1);
            calls[1].allow();
          }
          if (scenario === 'stop-active') { await admitted.promise; first.stop(); first.stop(); }
          if (scenario === 'close-active') {
            await admitted.promise;
            const closing = runner.close();
            assert.equal(runner.activeCount, 1);
            assert.throws(() => runner.start(request, callbacks), /closing/);
            await closing;
          }
          if (ownsBackground) {
            let finished = false; first.completion.then(() => { finished = true; });
            await parent.promise;
            for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
            assert.equal(finished, false); assert.equal(closed.length, 0);
            background.resolve();
            for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
            assert.equal(finished, false); assert.equal(closed.length, 0); resumed.resolve();
          }
          const result = await first.completion;
          if (scenario.startsWith('stop-') || scenario === 'close-active' || scenario === 'cancel-one') assert.equal(result.outcome, 'stopped');
          else if (['failure', 'truncated', 'missing-directory', 'parent-failure-background'].includes(scenario)) assert.equal(result.outcome, 'failed');
          else assert.equal(result.outcome, 'succeeded');
          if (scenario === 'failure') {
            assert.ok(result.text.includes('result:' + a));
            assert.ok(!result.error.includes('private-fixture-secret'));
          }
          if (scenario === 'truncated') { assert.equal(result.truncated, true); assert.equal(result.text.length, 65536); }
          if (ownsBackground) assert.equal(result.text, 'native-child-summary');
          if (second) {
            assert.equal((await second.completion).outcome, 'succeeded');
            assert.notEqual(first.id, second.id); assert.notEqual(calls[0].sessionKey, calls[1].sessionKey);
            assert.equal(calls[0].cwd, a); assert.equal(calls[1].cwd, b);
            assert.ok(JSON.stringify(calls[0].input).includes('owned-task-a'));
            assert.ok(!JSON.stringify(calls[0].input).includes('mutated'));
          }
          assert.equal(runner.activeCount, 0);
          assert.equal(calls.length, ['stop-before-start', 'missing-directory'].includes(scenario) ? 0 : second ? 2 : 1);
          assert.equal(closed.length, calls.length);
          assert.equal(new Set(closed).size, calls.length);
          if (calls.length) {
            assert.equal(calls[0].model, 'offline-fixture');
            assert.equal(calls[0].input.inputContext.actorId, 'actual-actor');
            assert.equal(calls[0].input.inputContext.sourceMessageId, 'actual-source');
            assert.ok(sends.filter(x => x.text.startsWith('result:')).every(x => x.chat === 'actual-chat' && x.anchor === 'actual-topic'));
          }
          first.stop(); await runner.close(); await runner.close();
          assert.throws(() => runner.start(request, callbacks), /closing/);
          console.log('independent-agent-task: passed');
        } finally { release.resolve(); background.resolve(); resumed.resolve(); await runner.close(); }
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
      expect(result.stdout).toContain('independent-agent-task: passed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
);
