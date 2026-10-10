import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const canary = 'test-credential-must-not-appear-in-errors';

describe('CLI configuration error reporting', () => {
  it.each([
    ['glm.model', { agent: { agentBackend: 'claude', provider: 'glm' }, glm: { apiKey: canary, apiBaseUrl: 'http://127.0.0.1:1' } }],
    ['glm.apiBaseUrl', { agent: { agentBackend: 'claude', provider: 'glm' }, glm: { apiKey: canary, model: 'test-model' } }],
    ['anthropic.apiKey', { agent: { agentBackend: 'claude', provider: 'anthropic', model: 'test-model' }, anthropic: { apiKey: '' } }],
  ])('reports %s, exits unsuccessfully and releases the process lock', async (field, configuration) => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-cli-config-'));
    try {
      const configPath = join(root, 'config.yaml');
      const lockPath = join(root, 'service.pid');
      const settingsDir = join(root, 'claude-settings');
      mkdirSync(settingsDir);
      writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({
        model: 'sdk-settings-model', env: { ANTHROPIC_MODEL: 'sdk-settings-env-model' },
      }));
      const probe = createServer();
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', resolve);
      });
      const address = probe.address();
      if (!address || typeof address === 'string') { throw new Error('Expected a TCP address'); }
      const { port } = address;
      await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
      writeFileSync(configPath, JSON.stringify({
        ...configuration,
        workspace: { dir: root },
        logging: { level: 'silent' },
        channels: { rest: { host: '127.0.0.1', port, fileStorageDir: root } },
      }));
      const result = spawnSync(process.execPath, ['bin/disclaude.js', 'start', '--config', configPath, '--api-port', '0'], {
        cwd: repo,
        env: {
          ...process.env,
          DISCLAUDE_CONFIG_PATH: configPath,
          CLAUDE_CONFIG_DIR: settingsDir,
          LOCKFILE_PATH: lockPath,
          LOG_DIR: join(root, 'logs'),
          LOG_TO_FILE: 'false',
          ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_MODEL: '', CODEX_MODEL: '',
        },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('配置校验未通过');
      expect(result.stderr).toContain(field);
      expect(result.stderr).not.toContain('Error: No API key configured.');
      expect(`${result.stdout}${result.stderr}`).not.toContain(canary);
      expect(existsSync(lockPath)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
