import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('returns an independently executed child result through the actual parent query tool port', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-task-tool-runtime-'));
  try {
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ workspace: { dir: root },
      agents: { default: { backend: 'claude', llm: 'default' } },
      llms: { default: { model: 'offline-fixture', api: { protocol: 'anthropic', apiKey: '$TEST_LLM_DEFAULT_KEY' } } },
    }));
    const script = `
      import assert from 'node:assert/strict';
      import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
      import { join } from 'node:path';
      import { getProvider } from './packages/core/dist/index.js';
      import { prepareTools } from './packages/core/dist/sdk/tools.js';
      import { AgentTaskRunner } from './packages/service/dist/agents/agent-task-runner.js';
      import { createAgentTaskTool } from './packages/service/dist/agents/agent-task-tool.js';
      import { createChatAgent } from './packages/service/dist/agents/create-chat-agent.js';
      globalThis.fetch = async () => { throw new Error('Live fetch forbidden'); };
      const root = realpathSync(${JSON.stringify(root)}), output = [];
      let childQueries = 0, parentClosed = 0, childClosed = 0;
      getProvider('claude').queryStream = (input, options) => {
        let close; const closed = new Promise(resolve => { close = resolve; });
        return { handle: { close: () => {
          if (options.sessionKey === 'parent-native') parentClosed++; else childClosed++;
          close();
        }, cancel: () => {} }, iterator: (async function* () {
          const source = (await input.next()).value;
          assert.equal(source.inputContext.actorId, 'actual-actor');
          assert.equal(source.inputContext.sourceMessageId, 'actual-source');
          if (options.sessionKey === 'parent-native') {
            const tools = prepareTools(options.tools); assert.equal(tools.length, 1);
            const args = { operationId: 'review_1', task: 'Review this artifact', workingDirectory: '.' };
            const results = await Promise.all([tools[0].execute(args, { signal: new AbortController().signal }),
              tools[0].execute(args, { signal: new AbortController().signal })]);
            assert.equal(results[0].outcome, 'succeeded'); assert.equal(results[0].id, results[1].id);
            yield { type: 'text', role: 'assistant', content: 'Parent consumed: ' + results[0].text };
          } else {
            childQueries++; assert.equal(options.cwd, root); assert.equal(options.tools, undefined);
            appendFileSync(join(root, 'owned-artifact.txt'), 'one execution\\n');
            yield { type: 'text', role: 'assistant', content: 'Artifact checked with evidence' };
          }
          yield { type: 'result', content: '', metadata: { stopReason: 'end_turn' } };
          await closed;
        })() };
      };
      const callbacks = { sendMessage: async (chat, text, anchor) => {
        assert.equal(chat, 'actual-chat'); assert.equal(anchor, 'actual-topic'); output.push(text); return 'offline-receipt';
      }, sendCard: async () => {}, sendFile: async () => {} };
      const runner = new AgentTaskRunner();
      const source = { chatId: 'actual-chat', sourceMessageId: 'actual-source', senderOpenId: 'actual-actor', threadRootId: 'actual-topic' };
      const tool = createAgentTaskTool(runner, { source, projectRoot: root, callbacks });
      const parent = createChatAgent({ chatId: 'actual-chat', callbacks, agentBackend: 'claude', apiKey: 'offline-key',
        apiProtocol: 'anthropic', model: 'offline-fixture', skipHistory: true, sdkSessionKey: 'parent-native',
        cwdProvider: () => root, configureQueryOptions: options => ({ ...options, tools: [tool] }),
      });
      try {
        await parent.processMessage({ chatId: source.chatId, messageId: source.sourceMessageId,
          senderOpenId: source.senderOpenId, threadRootId: source.threadRootId, payload: 'Use an independent reviewer' });
        await parent.turnCompleteFor(source.sourceMessageId); await parent.waitForWorkSettlement();
        assert.equal(childQueries, 1); assert.equal(childClosed, 1); assert.equal(runner.activeCount, 0);
        assert.equal(readFileSync(join(root, 'owned-artifact.txt'), 'utf8'), 'one execution\\n');
        assert.ok(output.includes('Parent consumed: Artifact checked with evidence'));
      } finally { parent.dispose(); await runner.close(); }
      assert.equal(parentClosed, 1); console.log('parent-task-tool-roundtrip: passed');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      env: { ...process.env, TEST_LLM_DEFAULT_KEY: 'offline-key', DISCLAUDE_CONFIG_PATH: configPath,
        DISCLAUDE_WORKSPACE_DIR: root, LOG_LEVEL: 'error', LOG_TO_FILE: 'false', NODE_ENV: 'test' },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(result.stderr).toBe(''); expect(result.signal).toBeNull();
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('parent-task-tool-roundtrip: passed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
