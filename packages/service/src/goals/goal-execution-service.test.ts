import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));

/** Single-entry scenarios (#5212): `/goal <prompt>` launches, `/stop` stops.
 * Continuation after `blocked` starts a new Goal and keeps the old record.
 */
it.each(['complete', 'blocked-new-goal', 'stop', 'close', 'revoked', 'denied', 'missing-project-stop', 'two-goals-stop'])(
  'runs the single-entry Goal service through %s', scenario => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-goal-service-'));
    try {
      const config = join(root, 'config.json');
      writeFileSync(config, JSON.stringify({ workspace: { dir: root },
        agents: { default: { backend: 'claude', llm: 'default' } },
        llms: { default: { model: 'offline-default', api: { protocol: 'anthropic', apiKey: '$TEST_LLM_DEFAULT_KEY' } } },
      }));
      const script = `
        import assert from 'node:assert/strict';
        import { realpathSync, mkdirSync, appendFileSync, rmSync } from 'node:fs';
        import { join } from 'node:path';
        import { GoalStore, ProjectManager, createControlHandler, createControlCommand, getProvider } from './packages/core/dist/index.js';
        import { prepareTools } from './packages/core/dist/sdk/tools.js';
        import { GoalExecutionService } from './packages/service/dist/goals/goal-execution-service.js';
        import { tryHandleSlashCommand } from './packages/service/dist/channels/feishu/command-router.js';
        globalThis.fetch = async () => { throw new Error('Live fetch forbidden'); };
        const scenario = ${JSON.stringify(scenario)}, root = realpathSync(${JSON.stringify(root)});
        const project = join(root, 'project'), other = join(root, 'other'); mkdirSync(project); mkdirSync(other);
        const store = new GoalStore(join(root, 'private-goals'));
        const manager = new ProjectManager({ workspaceDir: root }); manager.use('fixture-chat', project);
        const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
        const admitted = gate(), delivering = gate(), delivery = gate(), notified = gate();
        // Store writes are fs-backed (ms, not microtasks): waits must yield
        // real timer turns or assertions outrun the durable transitions.
        const waitFor = async check => { const end = Date.now() + 2000;
          while (!check()) { if (Date.now() > end) { return; } await new Promise(resolve => setTimeout(resolve, 1)); } };
        const settle = async () => { for (let i = 0; i < 30; i++) {
          await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setTimeout(resolve, 0)); } };
        const queries = [], policies = [], replies = [], sends = [];
        let allowed = scenario !== 'denied'; const runtime = { model: 'fixed-offline' };
        // Per-round assessment table: round 1 belongs to the first Goal; a
        // 'continue' keeps it running while later rounds may belong to another.
        const outcomes = {
          'complete': ['continue', 'continue', 'completed'],
          'blocked-new-goal': ['blocked', 'completed'],
          'stop': ['continue'], 'close': ['continue', 'completed'], 'revoked': ['continue'],
          'missing-project-stop': ['continue'], 'two-goals-stop': ['continue', 'completed'],
        }[scenario];
        const parksRoundResult = ['stop', 'close', 'missing-project-stop', 'two-goals-stop'].includes(scenario);
        // Runtime selection is pinned at each Goal's launch: only rounds of a
        // Goal launched after the mutation run with the changed model.
        const changedRounds = { 'blocked-new-goal': [2], 'two-goals-stop': [2], 'close': [2] }[scenario] ?? [];
        getProvider('claude').queryStream = (input, options) => {
          const parked = gate(); const round = queries.length + 1; queries.push(options);
          return { handle: { close: () => { parked.release(); }, cancel: () => {} },
            iterator: (async function* () {
              await input.next(); assert.equal(options.cwd, project);
              assert.equal(options.model, changedRounds.includes(round) ? 'changed-offline' : 'fixed-offline');
              appendFileSync(join(project, 'work.log'), 'write ' + round + '\\n');
              const tool = prepareTools(options.tools).find(tool => tool.name === 'goal_report');
              const outcome = outcomes[round - 1] ?? 'completed';
              const done = outcome === 'completed';
              await tool.execute({ outcome, progress: 'round ' + round,
                artifacts: ['work.log'], checks: [{ criterion: 0, satisfied: done, evidence: done ? ['work.log'] : [] }] },
              { signal: new AbortController().signal });
              admitted.release(); if (scenario === 'revoked') allowed = false;
              yield { type: 'text', role: 'assistant', content: 'round result ' + round };
              yield { type: 'result', content: '', metadata: { stopReason: 'end_turn' } };
              await parked.promise;
            })() };
        };
        const callbacks = { sendMessage: async (chat, text, topic) => {
          sends.push({ chat, text, topic });
          if (parksRoundResult && text === 'round result 1') {
            delivering.release(); await delivery.promise;
          }
          if (text.startsWith('Goal ')) notified.release(); return 'fixture-receipt';
        }, sendCard: async () => {}, sendFile: async () => {} };
        const options = { store, projectManager: manager, runtimeOptions: () => runtime, callbacks: () => callbacks,
          isCommandAllowed: command => { policies.push(command); return allowed; } };
        let service = new GoalExecutionService(options);
        const common = { projectManager: manager,
          agentPool: { reset() {}, stop() { return false; }, stopThread() { return false; }, isProjectBusy: chat => service.isBusy(chat) },
          debugGroups: { getDebugGroup: () => null, setDebugGroup() {}, clearDebugGroup() {} } };
        const rootControl = createControlHandler(common);
        const userControl = createControlHandler({ ...common, goalStore: store, goalExecution: {
          start: (...args) => service.start(...args), control: (...args) => service.control(...args),
          stopForChat: (chat, topic) => service.stopForChat(chat, topic),
        } });
        const invoke = (text, sourceMessageId = 'fixture-launch') => tryHandleSlashCommand({ textWithoutMentions: text,
          chatId: 'fixture-chat', actorId: 'fixture-user', sourceMessageId, threadRootId: 'fixture-topic', chatType: 'topic', senderType: 'user' },
        { hasControlHandler: true, emitControl: userControl, sendMessage: async reply => { replies.push(reply); } });
        try {
          await invoke('/goal Deliver the artifact | Verify recorded evidence');
          const [id] = await store.listIds();
          if (scenario === 'denied') {
            assert.equal((await store.get(id)).status, 'draft'); assert.equal(queries.length, 0);
          } else {
            await admitted.promise; runtime.model = 'changed-offline';
            if (scenario === 'two-goals-stop') {
              await delivering.promise;
              await invoke('/goal Ship the second artifact | Record its evidence', 'fixture-launch-second');
              const second = (await store.listIds()).find(value => value !== id);
              await notified.promise;
              await settle();
              assert.equal((await store.get(second)).status, 'completed');
              assert.equal(service.isBusy('fixture-chat'), true);
              await invoke('/stop', 'fixture-stop');
              delivery.release();
              await waitFor(() => !service.isBusy('fixture-chat'));
              for (const goal of [id, second]) { assert.equal((await store.get(goal)).status, goal === id ? 'abandoned' : 'completed'); }
              assert.equal(queries.length, 2);
            } else if (['stop', 'close', 'missing-project-stop'].includes(scenario)) {
              await delivering.promise; assert.equal(service.isBusy('fixture-chat'), true);
              const blockedSwitch = await rootControl(createControlCommand('project', 'fixture-chat', { args: ['use', other] }));
              assert.equal(blockedSwitch.success, false); assert.equal(manager.resolveCwd('fixture-chat').boundWorkingDir, project);
              if (scenario === 'missing-project-stop') rmSync(project, { recursive: true });
              let closing, closed = false;
              if (scenario === 'close') { closing = service.close(); closing.then(() => { closed = true; }); }
              else await invoke('/stop', 'fixture-stop');
              for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
              assert.equal(service.isBusy('fixture-chat'), true); assert.equal(closed, false);
              if (scenario === 'stop') {
                assert.ok(replies.some(reply => reply.text.includes('Goal')));
                assert.ok(replies.every(reply => !reply.text.includes('/goal show')));
              }
              delivery.release();
              if (scenario === 'close') { await closing; }
              else { await waitFor(() => !service.isBusy('fixture-chat')); }
              assert.equal((await store.get(id)).status, scenario === 'close' ? 'active' : 'abandoned');
              assert.equal(queries.length, 1);
              if (scenario === 'close') {
                // A restart rebuilds the service; the channel handler and the
                // busy gate follow the new instance, not the drained one.
                service = new GoalExecutionService(options); assert.equal(service.isBusy('fixture-chat'), false);
                await invoke('/goal Continue after restart | Finish the work', 'fixture-relaunch');
                const resumed = (await store.listIds()).find(value => value !== id);
                await notified.promise;
                await settle();
                assert.equal(service.isBusy('fixture-chat'), false);
                assert.equal((await store.get(resumed)).status, 'completed'); assert.equal(queries.length, 2);
                await service.close();
              }
            } else {
              await notified.promise; await settle();
              const record = await store.get(id);
              assert.equal(service.isBusy('fixture-chat'), false);
              if (scenario === 'blocked-new-goal') {
                assert.equal(record.status, 'blocked');
                assert.ok(sends.some(send => send.text.includes('等待你的决定') && send.text.includes('/goal')));
                assert.ok(sends.every(send => !send.text.includes('/goal show')));
                await invoke('/goal Continue with the decision | Finish the artifact', 'fixture-continue');
                const second = (await store.listIds()).find(value => value !== id);
                await notified.promise; await settle();
                assert.equal((await store.get(id)).status, 'blocked');
                assert.equal((await store.get(second)).status, 'completed');
                assert.equal(queries.length, 2);
              } else if (scenario === 'revoked') {
                assert.equal(record.status, 'active'); assert.equal(queries.length, 1);
                assert.ok(sends.some(send => send.text.includes('本轮推进失败')));
                assert.ok(sends.every(send => !send.text.includes('/goal show')));
              } else {
                assert.equal(record.status, 'completed'); assert.equal(queries.length, 3);
                assert.ok(sends.some(send => send.text.includes('已完成') && send.text.includes('Deliver the artifact') && send.text.includes('round 3')));
                assert.ok(sends.every(send => !send.text.includes('/goal show')));
              }
            }
          }
          assert.ok(policies.every(command => command.chatType === 'topic'));
          assert.ok(sends.every(send => send.chat === 'fixture-chat' && send.topic === 'fixture-topic'));
          console.log('goal-execution-service: passed');
        } finally { delivery.release(); await service.close(); }
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: repo, env: { ...process.env, TEST_LLM_DEFAULT_KEY: 'offline-key',
          ['DIS' + 'CLAUDE_CONFIG_PATH']: config, ['DIS' + 'CLAUDE_WORKSPACE_DIR']: root,
          NODE_ENV: 'test', LOG_LEVEL: 'error', LOG_TO_FILE: 'false',
        }, encoding: 'utf8', timeout: 15_000,
      });
      expect(result.signal, result.stderr || result.stdout).toBeNull();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('goal-execution-service: passed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
