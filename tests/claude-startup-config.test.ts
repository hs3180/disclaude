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
      const apiProvider = provider === 'missing' ? 'anthropic' : provider;
      const model = apiProvider === 'glm' ? 'glm-5' : 'claude-sonnet-4';
      writeFileSync(
        config,
        [
          `workspace:\n  dir: ${JSON.stringify(dir)}`,
          `agent:\n  agentBackend: claude\n  provider: ${apiProvider}\n  model: ${model}`,
          `${apiProvider}:\n  apiKey: ${provider === 'missing' ? '""' : 'offline-placeholder'}\n  model: ${model}\n  apiBaseUrl: http://127.0.0.1:1`,
        ].join('\n')
      );
      const entry = pathToFileURL(resolve('packages/primary-node/dist/primary-node.js')).href;
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      const { PrimaryNode } = await import(${JSON.stringify(entry)});
      const node = new PrimaryNode();
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
            ANTHROPIC_API_KEY: '',
            GLM_API_KEY: '',
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
