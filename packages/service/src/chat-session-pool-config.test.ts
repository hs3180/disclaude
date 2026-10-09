import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

describe('preset switching with real configuration and providers', () => {
  it.each(['codex', 'deepseek'])('validates the target independently of a %s default', (backend) => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-preset-config-'));
    try {
      const configPath = join(root, 'config.yaml');
      writeFileSync(configPath, JSON.stringify({
        workspace: { dir: root },
        logging: { level: 'silent' },
        agent: { agentBackend: backend, model: 'gpt-6-luna' },
        glm: { apiKey: 'selected-glm-key', apiBaseUrl: 'http://127.0.0.1:1' },
        anthropic: { apiKey: 'selected-anthropic-key', apiBaseUrl: 'http://127.0.0.1:2' },
        agents: {
          native: { default: true, agentBackend: backend, model: 'gpt-6-luna' },
          glm: { agentBackend: 'claude', provider: 'glm', model: 'selected-glm-model' },
          anthropic: { agentBackend: 'claude', provider: 'anthropic', model: 'selected-anthropic-model' },
          invalid: { agentBackend: 'claude', provider: 'glm', model: 'selected-glm-model', apiBaseUrl: 'file:///invalid' },
        },
      }));
      const script = `
        import assert from 'node:assert/strict';
        import { Config, getProvider } from './packages/core/dist/index.js';
        import { ChatSessionPool } from './packages/service/dist/chat-session-pool.js';
        import { AgentFactory } from './packages/service/dist/agents/factory.js';
        const pool = new ChatSessionPool();
        const callbacks = { sendMessage: async () => {}, sendCard: async () => {}, sendFile: async () => {} };
        try {
          const original = pool.getOrCreateChatAgent('test-chat', callbacks);
          assert.equal(Config.getAgentConfig().apiKey, '');
          const rejected = pool.switchAgentPreset('test-chat', 'invalid');
          assert.equal(rejected.ok, false);
          assert.match(rejected.error, /apiBaseUrl/);
          assert.equal(pool.getOrCreateChatAgent('test-chat', callbacks), original);
          assert.equal(pool.getActiveAgentPreset('test-chat').name, 'native');
          for (const [name, key, endpoint] of [
            ['glm', 'selected-glm-key', 'http://127.0.0.1:1'],
            ['anthropic', 'selected-anthropic-key', 'http://127.0.0.1:2'],
          ]) {
            const selected = AgentFactory.resolveConfig(Config.getAgentPresets()[name]);
            assert.equal(selected.apiKey, key);
            assert.equal(selected.apiBaseUrl, endpoint);
            assert.equal(getProvider('claude').getInfo(selected).available, true);
            assert.equal(pool.switchAgentPreset('test-chat', name).ok, true);
            assert.equal(pool.getActiveAgentPreset('test-chat').name, name);
          }
          const current = pool.getOrCreateChatAgent('test-chat', callbacks);
          Object.defineProperty(Config, 'GLM_API_KEY', { value: '' });
          const missingKey = pool.switchAgentPreset('test-chat', 'glm');
          assert.equal(missingKey.ok, false);
          assert.match(missingKey.error, /glm.apiKey/);
          assert.equal(pool.getOrCreateChatAgent('test-chat', callbacks), current);
          assert.equal(pool.getActiveAgentPreset('test-chat').name, 'anthropic');
          console.log('target-config-and-session-preservation: passed');
        } finally { pool.disposeAll(); }
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: repo,
        env: { ...process.env, DISCLAUDE_CONFIG_PATH: configPath, ANTHROPIC_MODEL: '', CODEX_MODEL: '', LOG_LEVEL: 'silent' },
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
