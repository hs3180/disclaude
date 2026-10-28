import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
it.each(['success', 'missing-report', 'native-failure', 'background', 'delivery', 'delivery-failure', 'cancel', 'close', 'foreign-scope', 'missing-directory'])(
  'executes an assessed native Goal turn through %s', scenario => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-native-goal-'));
    try {
      const configPath = join(root, 'config.json');
      writeFileSync(configPath, JSON.stringify({ workspace: { dir: root },
        agents: { default: { backend: 'claude', llm: 'default' } },
        llms: { default: { model: 'offline-fixture', api: { protocol: 'anthropic', apiKey: '$TEST_LLM_DEFAULT_KEY' } } },
      }));
      const script = `
        import assert from 'node:assert/strict';
        import { realpathSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
        import { join } from 'node:path';
        import { getProvider } from './packages/core/dist/index.js';
        import { prepareTools } from './packages/core/dist/sdk/tools.js';
        import { NativeGoalExecutor } from './packages/service/dist/agents/native-goal-executor.js';
        globalThis.fetch = async () => { throw new Error('Live fetch forbidden'); };
        const scenario = ${JSON.stringify(scenario)}, root = realpathSync(${JSON.stringify(root)});
        const project = join(root, 'project'); mkdirSync(project);
        const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
        const admitted = gate(), parent = gate(), background = gate(), resumed = gate(), work = gate(), delivering = gate(), delivery = gate();
        const calls = [], sends = []; let closed = 0, hookCalls = 0;
        getProvider('claude').queryStream = (input, options) => {
          const parked = gate(); calls.push(options);
          return { handle: { close: () => { closed++; parked.release(); work.release(); background.release(); resumed.release(); }, cancel: () => {} },
            iterator: (async function* () {
              const item = (await input.next()).value;
              assert.equal(item.inputContext.actorId, 'actual-actor'); assert.equal(item.inputContext.sourceMessageId, 'actual-source');
              assert.equal(options.cwd, project); assert.equal(options.model, 'selected-offline');
              assert.equal(options.onAsyncUserInputAnswer, undefined);
              const tool = prepareTools(options.tools).find(tool => tool.name === 'goal_report'); assert.ok(tool);
              writeFileSync(join(project, 'artifact.txt'), 'owned-write');
              if (scenario !== 'missing-report') {
                const receipt = await tool.execute({ outcome: 'completed', progress: 'Evidence checked', artifacts: ['artifact.txt'],
                  checks: [{ criterion: 0, satisfied: true, evidence: ['artifact.txt'] }] }, { signal: new AbortController().signal });
                assert.equal(receipt.saved, false); assert.equal(receipt.revision, 2);
              }
              admitted.release();
              if (scenario === 'cancel' || scenario === 'close') await work.promise;
              if (scenario === 'background') yield { type: 'status', content: '', metadata: { backgroundTaskIds: ['native-child'] } };
              yield { type: 'text', role: 'assistant', content: 'round result' };
              yield { type: 'result', content: '', metadata: scenario === 'native-failure'
                ? { terminatedReason: 'turn_failed', terminationDetail: 'offline failure' } : { stopReason: 'end_turn' } };
              parent.release();
              if (scenario === 'background') {
                await background.promise;
                yield { type: 'status', content: '', metadata: { backgroundTaskIds: [] } };
                await resumed.promise;
                yield { type: 'text', role: 'assistant', content: 'background continuation' };
                yield { type: 'result', content: '', metadata: { stopReason: 'end_turn' } };
              }
              await parked.promise;
            })() };
        };
        const executor = new NativeGoalExecutor({ runtimeOptions: () => ({ model: 'selected-offline',
          configureQueryOptions: options => { hookCalls++; return options; } }),
          callbacks: () => ({ sendMessage: async (chat, text, topic) => {
            sends.push({ chat, text, topic });
            if (scenario === 'delivery-failure') throw new Error('offline delivery failed');
            if (scenario === 'delivery') { delivering.release(); await delivery.promise; }
          }, sendCard: async () => {}, sendFile: async () => {} }) });
        const goal = { version: 1, id: '00000000-0000-4000-8000-000000000000', revision: 2, status: 'active',
          chatId: 'actual-chat', projectRoot: project, objective: 'Verify the artifact', acceptance: ['Record evidence'], progress: '', artifacts: [],
          createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z' };
        const source = { chatId: 'actual-chat', projectRoot: project, actorId: 'actual-actor', sourceMessageId: 'actual-source', threadRootId: 'actual-topic' };
        const controller = new AbortController();
        if (scenario === 'missing-directory') rmSync(project, { recursive: true });
        const result = executor.runTurn(goal, scenario === 'foreign-scope' ? { ...source, chatId: 'other' } : source, controller.signal)
          .then(report => ({ report }), error => ({ error }));
        try {
          if (!['foreign-scope', 'missing-directory'].includes(scenario)) await admitted.promise;
          if (scenario === 'background') {
            await parent.promise;
            for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
            assert.equal(executor.isBusy('actual-chat'), true); assert.equal(closed, 0);
            background.release();
            for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
            assert.equal(executor.isBusy('actual-chat'), true); assert.equal(closed, 0); resumed.release();
          }
          if (scenario === 'delivery') {
            await delivering.promise; assert.equal(executor.isBusy('actual-chat'), true); assert.equal(closed, 0); delivery.release();
          }
          if (scenario === 'cancel') controller.abort();
          if (scenario === 'close') {
            const closing = executor.close(); assert.equal(executor.close(), closing); await closing;
            assert.ok((await executor.runTurn(goal, source, controller.signal).catch(error => error)).message.includes('closing'));
          }
          const outcome = await result;
          if (['success', 'background', 'delivery'].includes(scenario)) assert.equal(outcome.report.outcome, 'completed');
          else assert.ok(outcome.error);
          if (scenario === 'missing-report') assert.ok(outcome.error.message.includes('without an assessment'));
          assert.equal(executor.isBusy('actual-chat'), false);
          assert.equal(calls.length, ['foreign-scope', 'missing-directory'].includes(scenario) ? 0 : 1);
          assert.equal(closed, calls.length); assert.equal(hookCalls, calls.length);
          if (calls.length) assert.equal(readFileSync(join(project, 'artifact.txt'), 'utf8'), 'owned-write');
          assert.ok(sends.every(send => send.chat === 'actual-chat' && send.topic === 'actual-topic'));
          console.log('native-goal-executor: passed');
        } finally { work.release(); background.release(); resumed.release(); delivery.release(); await executor.close(); }
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: repo, env: { ...process.env, TEST_LLM_DEFAULT_KEY: 'offline-key',
          ['DIS' + 'CLAUDE_CONFIG_PATH']: configPath, ['DIS' + 'CLAUDE_WORKSPACE_DIR']: root,
          LOG_LEVEL: 'error', LOG_TO_FILE: 'false', NODE_ENV: 'test',
        }, encoding: 'utf8', timeout: 10_000,
      });
      expect(result.signal, result.stderr || result.stdout).toBeNull();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('native-goal-executor: passed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
