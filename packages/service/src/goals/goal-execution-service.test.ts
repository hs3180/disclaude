import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
it.each(['complete', 'stop-delivery', 'close', 'revoked', 'denied', 'missing-project-pause', 'two-goals'])(
  'runs the user-channel Goal service through %s', scenario => {
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
        const queries = [], policies = [], replies = [], sends = []; let closes = 0, lastStart;
        let allowed = scenario !== 'denied'; const runtime = { model: 'fixed-offline' };
        getProvider('claude').queryStream = (input, options) => {
          const parked = gate(); const round = queries.length + 1; queries.push(options);
          return { handle: { close: () => { closes++; parked.release(); }, cancel: () => {} },
            iterator: (async function* () {
              await input.next(); assert.equal(options.cwd, project);
              assert.equal(options.model, ['stop-delivery', 'two-goals'].includes(scenario) && round === 2 ? 'changed-offline' : 'fixed-offline');
              appendFileSync(join(project, 'work.log'), 'write ' + round + '\\n');
              const tool = prepareTools(options.tools).find(tool => tool.name === 'goal_report');
              const done = scenario !== 'complete' || round === 3;
              await tool.execute({ outcome: done ? 'completed' : 'continue', progress: 'round ' + round,
                artifacts: ['work.log'], checks: [{ criterion: 0, satisfied: done, evidence: done ? ['work.log'] : [] }] },
              { signal: new AbortController().signal });
              admitted.release(); if (scenario === 'revoked') allowed = false;
              yield { type: 'text', role: 'assistant', content: scenario === 'two-goals' ? 'round result ' + round : 'round result' };
              yield { type: 'result', content: '', metadata: { stopReason: 'end_turn' } };
              await parked.promise;
            })() };
        };
        const callbacks = { sendMessage: async (chat, text, topic) => {
          sends.push({ chat, text, topic });
          if ((text === 'round result' && ['stop-delivery', 'close', 'missing-project-pause'].includes(scenario)) ||
              (scenario === 'two-goals' && text === 'round result 1')) {
            delivering.release(); await delivery.promise;
          }
          if (text.startsWith('Goal ')) notified.release(); return 'fixture-receipt';
        }, sendCard: async () => {}, sendFile: async () => {} };
        const options = { store, projectManager: manager, runtimeOptions: () => runtime, callbacks: () => callbacks,
          isCommandAllowed: command => { policies.push(command); return allowed; } };
        const service = new GoalExecutionService(options);
        const common = { projectManager: manager,
          agentPool: { reset() {}, stop() { return false; }, isProjectBusy: chat => service.isBusy(chat) },
          debugGroups: { getDebugGroup: () => null, setDebugGroup() {}, clearDebugGroup: () => null } };
        const rootControl = createControlHandler(common);
        const userControl = createControlHandler({ ...common, goalStore: store, goalExecution: {
          start: async (...args) => { lastStart = await service.start(...args); return lastStart; },
          control: (...args) => service.control(...args), isRunning: id => service.isRunning(id),
        } });
        const invoke = (text, sourceMessageId = 'fixture-start') => tryHandleSlashCommand({ textWithoutMentions: text,
          chatId: 'fixture-chat', actorId: 'fixture-user', sourceMessageId, threadRootId: 'fixture-topic', chatType: 'topic', senderType: 'user' },
        { hasControlHandler: true, emitControl: userControl, sendMessage: async reply => { replies.push(reply); } });
        try {
          await invoke('/goal create Deliver the artifact | Verify recorded evidence', 'fixture-create');
          const [id] = await store.listIds();
          assert.equal((await rootControl(createControlCommand('goal', 'fixture-chat', { args: ['start', id, '1'] },
            { actorId: 'fixture-user', sourceMessageId: 'forged' }))).success, false);
          await invoke('/goal start ' + id + ' 1');
          if (scenario === 'denied') {
            assert.equal((await store.get(id)).status, 'draft'); assert.equal(queries.length, 0);
          } else {
            await admitted.promise; runtime.model = 'changed-offline';
            if (scenario === 'two-goals') {
              await delivering.promise; const first = lastStart.handle;
              await invoke('/goal create Another artifact | Record its evidence', 'fixture-create-second');
              const second = (await store.listIds()).find(value => value !== id);
              await invoke('/goal start ' + second + ' 1', 'fixture-second'); await notified.promise;
              await new Promise(resolve => setImmediate(resolve));
              assert.equal((await store.get(second)).status, 'completed');
              assert.equal(service.isRunning(id), true); assert.equal(service.isRunning(second), false);
              await invoke('/goal pause ' + id + ' 2', 'fixture-pause'); delivery.release(); await first.completion;
              await new Promise(resolve => setImmediate(resolve)); assert.equal((await store.get(id)).status, 'paused');
              assert.equal(queries.length, 2);
            } else if (['stop-delivery', 'close', 'missing-project-pause'].includes(scenario)) {
              await delivering.promise; assert.equal(service.isBusy('fixture-chat'), true);
              const blockedSwitch = await rootControl(createControlCommand('project', 'fixture-chat', { args: ['use', other] }));
              assert.equal(blockedSwitch.success, false); assert.equal(manager.resolveCwd('fixture-chat').boundWorkingDir, project);
              if (scenario === 'missing-project-pause') rmSync(project, { recursive: true });
              let closing, closed = false;
              if (scenario === 'close') { closing = service.close(); closing.then(() => { closed = true; }); }
              else await invoke('/goal pause ' + id + ' 2', 'fixture-pause');
              for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
              assert.equal(service.isBusy('fixture-chat'), true); assert.equal(closed, false);
              if (scenario === 'stop-delivery') {
                await invoke('/goal resume ' + id + ' 3', 'fixture-premature-resume'); assert.equal(queries.length, 1);
              }
              delivery.release(); await lastStart.handle.completion;
              await new Promise(resolve => setImmediate(resolve)); await closing;
              assert.equal(service.isRunning(id), false);
              if (scenario === 'stop-delivery') {
                await invoke('/goal resume ' + id + ' 3', 'fixture-resume'); await notified.promise;
                await new Promise(resolve => setImmediate(resolve)); assert.equal((await store.get(id)).status, 'completed'); assert.equal(queries.length, 2);
              } else if (scenario === 'close') {
                const restored = new GoalExecutionService(options); assert.equal(restored.isRunning(id), false);
                const read = createControlHandler({ ...common, goalStore: store, goalExecution: restored });
                const shown = await read(createControlCommand('goal', 'fixture-chat', { args: ['show', id] }, { actorId: 'fixture-user' }));
                assert.ok(shown.message.includes('没有所属的执行')); assert.equal(queries.length, 1); await restored.close();
              } else assert.equal((await store.get(id)).status, 'paused');
            } else {
              await notified.promise; await new Promise(resolve => setImmediate(resolve));
              assert.equal(service.isRunning(id), false);
              assert.equal((await store.get(id)).status, scenario === 'complete' ? 'completed' : 'active');
              assert.equal(queries.length, scenario === 'complete' ? 3 : 1);
            }
          }
          assert.equal(closes, queries.length); assert.ok(policies.every(command => command.chatType === 'topic'));
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
