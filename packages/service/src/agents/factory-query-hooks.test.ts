import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));

it.each(['task', 'chat', 'legacy'])('runs factory-supplied tools through the actual %s agent query', mode => {
  const root = mkdtempSync(join(tmpdir(), 'disclaude-factory-tools-'));
  try {
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ workspace: { dir: root },
      agents: { default: { backend: 'claude', llm: 'default' } },
      llms: { default: { model: 'offline-default', api: { protocol: 'anthropic', apiKey: '$TEST_LLM_DEFAULT_KEY' } } },
    }));
    const script = `
      import assert from 'node:assert/strict';
      import { realpathSync, writeFileSync, readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { getProvider } from './packages/core/dist/index.js';
      import { prepareTools } from './packages/core/dist/sdk/tools.js';
      import { AgentFactory } from './packages/service/dist/agents/factory.js';
      globalThis.fetch = async () => { throw new Error('Live fetch forbidden'); };
      const mode = ${JSON.stringify(mode)}, root = realpathSync(${JSON.stringify(root)});
      const chat = mode === 'legacy' ? 'default' : 'actual-chat';
      const artifact = join(root, 'verified.txt');
      const events = []; let queryCount = 0, hookCount = 0, closed = 0;
      const tool = { name: 'record_evidence', description: 'Record local verification evidence',
        inputSchema: { type: 'object', additionalProperties: false, properties: { evidence: { type: 'string' } }, required: ['evidence'] },
        outputSchema: { type: 'object', additionalProperties: false, properties: { recorded: { type: 'boolean' } }, required: ['recorded'] },
        execute: async (args, context) => {
          assert.equal(context.signal.aborted, false);
          writeFileSync(artifact, args.evidence); return { recorded: true };
        },
      };
      getProvider('claude').queryStream = (input, options) => {
        queryCount++;
        let release; const parked = new Promise(resolve => { release = resolve; });
        return { handle: { close: () => { closed++; release(); }, cancel: () => {} },
          iterator: (async function* () {
            assert.equal(options.model, 'offline-selected'); assert.equal(options.cwd, root);
            assert.equal(options.sessionKey, 'factory:' + mode);
            const item = (await input.next()).value;
            assert.equal(item.inputContext.actorId, 'actual-actor');
            const tools = prepareTools(options.tools);
            assert.equal(tools.length, 1);
            assert.deepEqual(await tools[0].execute({ evidence: 'verified-' + mode }, { signal: new AbortController().signal }), { recorded: true });
            yield { type: 'text', role: 'assistant', content: 'Verification finished' };
            yield { type: 'result', content: '', metadata: { stopReason: 'end_turn' } };
            await parked;
          })() };
      };
      const options = { model: 'offline-selected', sdkSessionKey: 'factory:' + mode, skipHistory: true,
        cwdProvider: () => root, cwdResolver: () => ({ effectiveCwd: root, boundWorkingDir: root, reason: 'bound' }),
        configureQueryOptions: options => { hookCount++; return { ...options, tools: [...(options.tools ?? []), tool] }; } };
      const callbacks = { sendMessage: async (chat, text) => { events.push({ chat, text }); }, sendCard: async () => {}, sendFile: async () => {},
        getChatHistory: async () => { throw new Error('History must be skipped'); } };
      const agent = mode === 'task' ? AgentFactory.createAgent(chat, callbacks, options)
        : mode === 'chat' ? AgentFactory.createChatAgent('pilot', chat, callbacks, options)
          : AgentFactory.createChatAgent('pilot', callbacks, options);
      try {
        await agent.processMessage({ chatId: chat, messageId: 'actual-source', senderOpenId: 'actual-actor', payload: 'Verify the artifact' });
        await agent.turnCompleteFor('actual-source');
        assert.equal(hookCount, 1); assert.equal(queryCount, 1);
        assert.equal(readFileSync(artifact, 'utf8'), 'verified-' + mode);
        assert.ok(events.some(event => event.chat === chat && event.text.includes('Verification finished')));
      } finally { agent.dispose(); }
      assert.equal(closed, 1);
      console.log('factory-query-hook: passed');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: repo, env: { ...process.env, TEST_LLM_DEFAULT_KEY: 'offline-key',
        NODE_ENV: 'test', LOG_LEVEL: 'error', LOG_TO_FILE: 'false',
        DISCLAUDE_CONFIG_PATH: configPath, DISCLAUDE_WORKSPACE_DIR: root,
      }, encoding: 'utf8', timeout: 10_000,
    });
    expect(result.signal, result.stderr || result.stdout).toBeNull();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('factory-query-hook: passed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
