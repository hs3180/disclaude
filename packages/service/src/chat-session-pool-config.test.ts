import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

describe('preset switching with real configuration and providers', () => {
  it.each(['codex', 'dsh'])('validates the target independently of a %s default', (backend) => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-preset-config-'));
    try {
      const configPath = join(root, 'config.yaml');
      writeFileSync(configPath, JSON.stringify({
        workspace: { dir: root },
        logging: { level: 'silent' },
        agents: {
          native: {
            backend, llm: 'native', default: true,
            ...(backend === 'dsh' ? { mode: 'minimal', dsh: {
              provider: 'native-test-route', dshHome: join(root, 'dsh-home'),
              apiKeyEnv: 'DISCLAUDE_NATIVE_CONFIG_TEST_KEY',
            } } : {}),
          },
          proxy: { backend: 'claude', llm: 'proxy' },
          direct: { backend: 'claude', llm: 'direct' },
          missing: { backend: 'claude', llm: 'missing' },
        },
        llms: {
          native: { model: backend === 'codex' ? 'gpt-6-luna' : 'native-model', reasoningEffort: 'max', maxConcurrentSessions: 3 },
          proxy: {
            model: 'glm-5.3',
            api: { protocol: 'anthropic', baseUrl: 'http://127.0.0.1:1', apiKey: '$PROXY_KEY' },
          },
          direct: {
            model: 'sonnet',
            api: { protocol: 'anthropic', baseUrl: 'http://127.0.0.1:2', apiKey: '$DIRECT_KEY' },
          },
          missing: {
            model: 'missing-model',
            api: { protocol: 'anthropic', apiKey: '$MISSING_KEY' },
          },
        },
        env: { DISCLAUDE_NATIVE_CONFIG_TEST_KEY: 'selected-native-test-key' },
      }));
      const script = `
        import assert from 'node:assert/strict';
        import { Config, getProvider } from './packages/core/dist/index.js';
        import { ChatSessionPool } from './packages/service/dist/chat-session-pool.js';
        import { AgentFactory } from './packages/service/dist/agents/factory.js';
        const pool = new ChatSessionPool();
        const callbacks = { sendMessage: async () => {}, sendCard: async () => {}, sendFile: async () => {} };
        try {
          if (Config.AGENT_BACKEND === 'dsh') {
            const preset = Config.getAgentPresets().native;
            assert.equal(preset.mode, 'minimal');
            assert.equal(Config.DSH_MODE, 'minimal');
            assert.equal(Config.DSH_PROVIDER, 'native-test-route');
            assert.equal(Config.DSH_HOME, preset.dsh.dshHome);
            assert.equal(Config.DSH_API_KEY, 'selected-native-test-key');
            assert.equal(getProvider('dsh').name, 'dsh');
            assert.equal(getProvider('dsh'), getProvider('dsh', preset));
          }
          const original = pool.getOrCreateChatAgent('test-chat', callbacks);
          assert.equal(Config.getAgentConfig().apiKey, '');
          assert.equal(Config.getAgentConfig().reasoningEffort, 'max');
          assert.equal(Config.getAgentConfig().maxConcurrentSessions, 3);
          assert.equal(Config.getAgentConfig().llm, 'native');
          const rejected = pool.switchAgentPreset('test-chat', 'missing');
          assert.equal(rejected.ok, false);
          assert.match(rejected.error, /credential/);
          assert.equal(pool.getOrCreateChatAgent('test-chat', callbacks), original);
          assert.equal(pool.getActiveAgentPreset('test-chat').name, 'native');
          for (const [name, key, endpoint] of [
            ['proxy', 'selected-proxy-key', 'http://127.0.0.1:1'],
            ['direct', 'selected-direct-key', 'http://127.0.0.1:2'],
          ]) {
            const selected = AgentFactory.resolveConfig(Config.getAgentPresets()[name]);
            assert.equal(selected.apiKey, key);
            assert.equal(selected.apiBaseUrl, endpoint);
            assert.equal(getProvider('claude').getInfo(selected).available, true);
            assert.equal(pool.switchAgentPreset('test-chat', name).ok, true);
            assert.equal(pool.getActiveAgentPreset('test-chat').name, name);
          }
          const current = pool.getOrCreateChatAgent('test-chat', callbacks);
          const missingKey = pool.switchAgentPreset('test-chat', 'missing');
          assert.equal(missingKey.ok, false);
          assert.match(missingKey.error, /credential/);
          assert.equal(pool.getOrCreateChatAgent('test-chat', callbacks), current);
          assert.equal(pool.getActiveAgentPreset('test-chat').name, 'direct');
          console.log('target-config-and-session-preservation: passed');
        } finally { pool.disposeAll(); }
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: repo,
        env: { ...process.env, DISCLAUDE_CONFIG_PATH: configPath, ANTHROPIC_MODEL: '', CODEX_MODEL: '', CODEX_REASONING_EFFORT: '', PROXY_KEY: 'selected-proxy-key', DIRECT_KEY: 'selected-direct-key', MISSING_KEY: '', LOG_LEVEL: 'silent' },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.stderr).toBe('');
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('target-config-and-session-preservation: passed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
