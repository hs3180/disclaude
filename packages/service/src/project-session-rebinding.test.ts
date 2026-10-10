import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

describe('Project commands with persistent chat and topic queries', () => {
  it.each(['use', 'reset'])('%s refreshes every affected topic cwd and preserves other chats', (subcommand) => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-project-sessions-'));
    try {
      const configPath = join(root, 'config.json');
      writeFileSync(configPath, JSON.stringify({ workspace: { dir: root },
        agent: { agentBackend: 'claude', provider: 'anthropic', model: 'test-model' },
        anthropic: { apiKey: 'test-key' } }));
      const script = `
        import assert from 'node:assert/strict';
        import { mkdirSync } from 'node:fs';
        import { join } from 'node:path';
        import { Config, ProjectManager, createControlHandler, getProvider } from './packages/core/dist/index.js';
        import { ChatSessionPool } from './packages/service/dist/chat-session-pool.js';
        const workspace = Config.getWorkspaceDir();
        const first = join(workspace, 'first'), second = join(workspace, 'second');
        mkdirSync(first); mkdirSync(second);
        const pm = new ProjectManager({ workspaceDir: workspace });
        const queries = [], output = [];
        getProvider('claude').queryStream = (input, options) => {
          const query = { cwd: options.cwd, sessionKey: options.sessionKey, closed: 0 };
          queries.push(query);
          return { handle: { close: () => { query.closed++; }, cancel: () => {} },
            iterator: (async function* () {
              for await (const message of input) {
                yield { type: 'text', content: JSON.stringify({ cwd: query.cwd }), role: 'assistant' };
                yield { type: 'result', content: '', metadata: { stopReason: 'end_turn' } };
              }
            })() };
        };
        const callbacks = { sendMessage: async (chat, text) => { output.push({ chat, text }); return 'owned-receipt'; },
          sendCard: async () => {}, sendFile: async () => {}, onDone: async () => {} };
        const pool = new ChatSessionPool({ cwdProvider: chat => pm.resolveCwd(chat).effectiveCwd,
          cwdResolver: chat => pm.resolveCwd(chat) });
        const control = createControlHandler({ projectManager: pm, agentPool: {
          reset: (chat, skip) => pool.reset(chat, skip), stop: chat => pool.stop(chat),
          resetThread: (chat, skip, root) => pool.reset(chat, skip, root),
          ...(pool.resetProjectSessions ? { resetProjectSessions: chat => pool.resetProjectSessions(chat) } : {}),
          ...(pool.isProjectBusy ? { isProjectBusy: chat => pool.isProjectBusy(chat) } : {}),
        }, debugGroups: { getDebugGroup: () => null, setDebugGroup: () => {}, clearDebugGroup: () => null } });
        const turn = async (chat, root, id) => {
          const agent = pool.getOrCreateChatAgent(chat, callbacks, root);
          await agent.processMessage({ chatId: chat, threadRootId: root, messageId: id, payload: id });
          await agent.turnCompleteFor(id);
          const reply = output.filter(value => value.chat === chat).at(-1);
          return { agent, cwd: JSON.parse(reply.text).cwd };
        };
        try {
          assert.equal((await control({ type: 'project', chatId: 'target', data: { subcommand: 'use', workingDir: first } })).success, true);
          assert.equal(pm.use('other', first).ok, true);
          const scopes = [undefined, 'topic-a', 'topic-b'];
          const previous = [];
          for (const [index, root] of scopes.entries()) {
            const result = await turn('target', root, 'before-' + index);
            assert.equal(result.cwd, first); previous.push(result.agent);
          }
          const other = await turn('other', 'other-topic', 'other-before');
          const subcommand = ${JSON.stringify(subcommand)};
          const response = await control({ type: 'project', chatId: 'target', threadRootId: 'topic-a',
            data: { subcommand, ...(subcommand === 'use' ? { workingDir: second } : {}) } });
          assert.equal(response.success, true);
          const expected = subcommand === 'use' ? second : workspace;
          assert.equal(pm.resolveCwd('target').effectiveCwd ?? workspace, expected);
          for (const [index, root] of scopes.entries()) {
            const result = await turn('target', root, 'after-' + index);
            assert.equal(result.cwd, expected, 'actual persistent SDK cwd for ' + (root ?? 'ordinary-chat'));
            assert.notEqual(result.agent, previous[index]);
          }
          const unchanged = await turn('other', 'other-topic', 'other-after');
          assert.equal(unchanged.agent, other.agent); assert.equal(unchanged.cwd, first);
          assert.equal(queries.filter(query => query.sessionKey === 'other::other-topic').length, 1);
          assert.equal(queries.length, 7);
          console.log('project-sessions-cwd-and-isolation: passed');
        } finally { pool.disposeAll(); }
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: repo, env: { ...process.env,
          DISCLAUDE_CONFIG_PATH: configPath, DISCLAUDE_WORKSPACE_DIR: root,
          LOG_LEVEL: 'error', LOG_TO_FILE: 'false', NODE_ENV: 'test' },
        encoding: 'utf8', timeout: 10_000,
      });
      expect(result.stderr).toBe('');
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('project-sessions-cwd-and-isolation: passed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
