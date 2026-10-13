import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Claude startup with real YAML configuration (offline)', () => {
  it.each(['anthropic', 'glm', 'missing'])(
    'handles %s credentials in a fresh process',
    (provider) => {
      const dir = mkdtempSync(join(tmpdir(), 'disclaude-claude-config-'));
      fixtures.push(dir);
      const config = join(dir, 'config.yaml');
      const model = provider === 'glm' ? 'glm-5.3' : 'claude-sonnet-4';
      writeFileSync(config, JSON.stringify({
        workspace: { dir },
        agents: { default: { backend: 'claude', llm: 'test' } },
        llms: { test: { model, api: { protocol: 'anthropic', baseUrl: 'http://127.0.0.1:1', apiKey: '$SMOKE_API_KEY' } } },
      }));
      const entry = pathToFileURL(resolve('packages/service/dist/service.js')).href;
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      const { DisclaudeService } = await import(${JSON.stringify(entry)});
      const node = new DisclaudeService();
      try {
        await node.start({ deferScheduler: true });
        await node.stop();
        console.log('STARTUP_OK');
        process.exit(0);
      } catch (error) {
        console.error(error.message);
        process.exit(2);
      }
    `,
        ],
        {
          cwd: dir,
          env: {
            ...process.env,
            HOME: dir,
            XDG_CONFIG_HOME: join(dir, '.config'),
            XDG_DATA_HOME: join(dir, '.local/share'),
            BU_CDP_URL: '',
            DISCLAUDE_CHROMIUM_CONFIG: join(dir, 'missing-chromium-cdp.json'),
            ANTHROPIC_API_KEY: '',
            SMOKE_API_KEY: provider === 'missing' ? '' : 'offline-placeholder',
            DISCLAUDE_CONFIG_PATH: config,
          },
          encoding: 'utf8',
          timeout: 15000,
        }
      );
      expect(result.error).toBeUndefined();
      if (provider === 'missing') {
        expect(result.status).toBe(2);
        expect(result.stderr).toContain('Claude API configuration is missing or invalid');
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('STARTUP_OK');
      }
    }
  );
});
