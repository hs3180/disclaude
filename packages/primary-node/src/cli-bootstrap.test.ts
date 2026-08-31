import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

import { EXPLICIT_CONFIG_PATH_ENV, findExplicitConfigPath } from './cli.js';

describe('Primary Node CLI config bootstrap (Issue #4654)', () => {
  afterEach(() => {
    delete process.env[EXPLICIT_CONFIG_PATH_ENV];
  });

  it('finds long and short config flags before core is imported', () => {
    expect(findExplicitConfigPath(['start', '--config', '/tmp/long.yaml'])).toBe('/tmp/long.yaml');
    expect(findExplicitConfigPath(['start', '-c', '/tmp/short.yaml'])).toBe('/tmp/short.yaml');
  });

  it('uses the last explicit config path, matching parseArgs', () => {
    expect(
      findExplicitConfigPath([
        'start',
        '--config',
        '/tmp/first.yaml',
        '-c',
        '/tmp/authoritative.yaml',
      ]),
    ).toBe('/tmp/authoritative.yaml');
  });

  it('does not consume another option as a missing config value', () => {
    expect(findExplicitConfigPath(['start', '--config', '--api-port', '9200'])).toBeUndefined();
  });

  it('makes --config authoritative before Config statics initialize in a fresh process', () => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-config-bootstrap-'));
    try {
      const explicitPath = join(root, 'explicit.yaml');
      writeFileSync(
        join(root, 'disclaude.config.yaml'),
        'agent:\n  agentBackend: codex\n  model: default-leak\n',
      );
      writeFileSync(
        explicitPath,
        'agent:\n  agentBackend: pi\n  model: explicit-model\n',
      );

      const cliUrl = pathToFileURL(join(process.cwd(), 'packages/primary-node/src/cli.ts')).href;
      const coreUrl = pathToFileURL(join(process.cwd(), 'packages/core/src/config/index.ts')).href;
      const tsxLoaderPath = createRequire(import.meta.url).resolve('tsx');
      const script = `
        const { bootstrap } = await import(${JSON.stringify(cliUrl)});
        await bootstrap(
          ['start', '--config', ${JSON.stringify(explicitPath)}],
          async () => {
            const { Config } = await import(${JSON.stringify(coreUrl)});
            return { main: async () => console.log(JSON.stringify({
              backend: Config.AGENT_BACKEND,
              model: Config.CLAUDE_MODEL,
              source: Config.CONFIG_SOURCE,
            })) };
          },
        );
      `;

      const child = spawnSync(
        process.execPath,
        ['--import', tsxLoaderPath, '--input-type=module', '--eval', script],
        { cwd: root, encoding: 'utf8' },
      );

      expect(child.stderr).toBe('');
      expect(child.status).toBe(0);
      const outputLines = child.stdout.trim().split('\n');
      expect(JSON.parse(outputLines.at(-1) ?? 'null')).toEqual({
        backend: 'pi',
        model: 'explicit-model',
        source: explicitPath,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
