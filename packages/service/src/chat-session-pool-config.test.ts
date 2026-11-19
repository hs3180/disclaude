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
      // Issue #5255 r4: `agents:` entries are keyed by harness name — the
      // same name space the orthogonal selection uses. The default marker
      // rides on the harness entry itself; there is no separate preset name.
      writeFileSync(
        configPath,
        JSON.stringify({
          workspace: { dir: root },
          logging: { level: 'silent' },
          agents: {
            [backend]: {
              llm: 'native',
              default: true,
              ...(backend === 'dsh' ? { mode: 'minimal', dshHome: join(root, 'dsh-home') } : {}),
            },
            claude: { llm: 'proxy' },
            pi: { llm: 'direct' },
            miniswe: { llm: 'missing' },
          },
          llms: {
            native: {
              defaultModel: backend === 'codex' ? 'gpt-6-luna' : 'native-model',
              reasoningEffort: 'max',
              maxConcurrentSessions: 3,
              ...(backend === 'dsh'
                ? {
                    api: {
                      protocol: 'openai',
                      baseUrl: 'https://dsh.example/v1',
                      apiKey: '$DISCLAUDE_NATIVE_CONFIG_TEST_KEY',
                    },
                  }
                : {}),
            },
            proxy: {
              defaultModel: 'glm-5.3',
              api: { protocol: 'anthropic', baseUrl: 'http://127.0.0.1:1', apiKey: '$PROXY_KEY' },
            },
            direct: {
              defaultModel: 'sonnet',
              // OpenAI-protocol binding: pi serves either protocol and its
              // model resolution requires the openai shape for aliases.
              api: { protocol: 'openai', baseUrl: 'http://127.0.0.1:2', apiKey: '$DIRECT_KEY' },
            },
            // Endpoint shape satisfies the miniswe binding matrix (protocol +
            // baseUrl); the empty key is what the provider must reject.
            missing: {
              defaultModel: 'missing-model',
              api: { protocol: 'anthropic', baseUrl: 'http://127.0.0.1:3', apiKey: '$MISSING_KEY' },
            },
          },
        })
      );
      const script = `
        import assert from 'node:assert/strict';
        import { Config, getProvider } from './packages/core/dist/index.js';
        import { ChatSessionPool } from './packages/service/dist/chat-session-pool.js';
        import { AgentFactory } from './packages/service/dist/agents/factory.js';
        const pool = new ChatSessionPool();
        const callbacks = { sendMessage: async () => {}, sendCard: async () => {}, sendFile: async () => {} };
        try {
          if (Config.AGENT_BACKEND === 'dsh') {
            const preset = Config.getAgentPresets().dsh;
            assert.equal(preset.mode, 'minimal');
            assert.equal(Config.DSH_MODE, 'minimal');
            assert.equal(Config.DSH_HOME, preset.dshHome);
            assert.equal(preset.apiProtocol, 'openai');
            assert.equal(preset.apiBaseUrl, 'https://dsh.example/v1');
            assert.equal(preset.apiKey, 'selected-native-test-key');
            assert.equal(getProvider('dsh').name, 'dsh');
            assert.equal(getProvider('dsh'), getProvider('dsh', preset));
          }
          const original = pool.getOrCreateChatAgent('test-chat', callbacks);
          assert.equal(Config.getAgentConfig().apiKey, Config.AGENT_BACKEND === 'dsh' ? 'selected-native-test-key' : '');
          assert.equal(Config.getAgentConfig().reasoningEffort, 'max');
          assert.equal(Config.getAgentConfig().maxConcurrentSessions, 3);
          assert.equal(Config.getAgentConfig().llm, 'native');
          assert.equal(pool.getActiveAgentPreset('test-chat').name, Config.AGENT_BACKEND);
          const rejected = pool.switchAgentPreset('test-chat', 'miniswe');
          assert.equal(rejected.ok, false);
          assert.match(rejected.error, /credential/);
          assert.equal(pool.getOrCreateChatAgent('test-chat', callbacks), original);
          assert.equal(pool.getActiveAgentPreset('test-chat').name, Config.AGENT_BACKEND);
          // Binding resolution of every harness key is provider-independent
          // and asserted for all entries; only claude is positively SWITCHED,
          // because pi/dsh/miniswe availability depends on harness binaries
          // this suite's environments do not provision.
          for (const [name, key, endpoint] of [
            ['claude', 'selected-proxy-key', 'http://127.0.0.1:1'],
            ['pi', 'selected-direct-key', 'http://127.0.0.1:2'],
          ]) {
            const selected = AgentFactory.resolveConfig(Config.getAgentPresets()[name]);
            assert.equal(selected.apiKey, key);
            assert.equal(selected.apiBaseUrl, endpoint);
          }
          assert.equal(getProvider('claude').getInfo(
            AgentFactory.resolveConfig(Config.getAgentPresets().claude)
          ).available, true);
          assert.equal(pool.switchAgentPreset('test-chat', 'claude').ok, true);
          assert.equal(pool.getActiveAgentPreset('test-chat').name, 'claude');
          const current = pool.getOrCreateChatAgent('test-chat', callbacks);
          const missingKey = pool.switchAgentPreset('test-chat', 'miniswe');
          assert.equal(missingKey.ok, false);
          assert.match(missingKey.error, /credential/);
          assert.equal(pool.getOrCreateChatAgent('test-chat', callbacks), current);
          assert.equal(pool.getActiveAgentPreset('test-chat').name, 'claude');
          console.log('target-config-and-session-preservation: passed');
        } finally { pool.disposeAll(); }
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: repo,
        env: {
          ...process.env,
          DISCLAUDE_CONFIG_PATH: configPath,
          ANTHROPIC_MODEL: '',
          CODEX_MODEL: '',
          CODEX_REASONING_EFFORT: '',
          PROXY_KEY: 'selected-proxy-key',
          DISCLAUDE_NATIVE_CONFIG_TEST_KEY: 'selected-native-test-key',
          DIRECT_KEY: 'selected-direct-key',
          MISSING_KEY: '',
          LOG_LEVEL: 'silent',
        },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.stderr).toBe('');
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('target-config-and-session-preservation: passed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
