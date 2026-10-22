import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigEnvironment, readDiscoveredConfigYaml } from './discovery.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true });} });

describe('loadConfigEnvironment', () => {
  it('reads only env values without initializing the Config singleton', () => {
    const root = mkdtempSync(join(tmpdir(), 'config-env-'));
    roots.push(root);
    const file = join(root, 'config.yaml');
    writeFileSync(file, 'workspace:\n  dir: /private/workspace\nenv:\n  CUSTOM_RUNTIME_FLAG: enabled\n  PORT: 43\n');
    expect(loadConfigEnvironment(file)).toEqual({ CUSTOM_RUNTIME_FLAG: 'enabled', PORT: '43' });
  });

  it('returns no values for a missing optional config', () => {
    const root = mkdtempSync(join(tmpdir(), 'config-env-'));
    roots.push(root);
    expect(loadConfigEnvironment(join(root, 'missing.yaml'))).toEqual({});
  });
});

describe('readDiscoveredConfigYaml (#5432)', () => {
  it('parses the raw document including nested channels.feishu and env references', () => {
    const root = mkdtempSync(join(tmpdir(), 'config-raw-'));
    roots.push(root);
    const file = join(root, 'config.yaml');
    writeFileSync(file, [
      'channels:',
      '  feishu:',
      '    appId: "cli_example"',
      '    appSecret: $FEISHU_APP_SECRET',
      'env:',
      '  PORT: 43',
    ].join('\n'));
    const result = readDiscoveredConfigYaml(file);
    expect(result.exists).toBe(true);
    expect(result.path).toBe(file);
    expect((result.config?.channels as Record<string, unknown>)?.feishu).toEqual({
      appId: 'cli_example',
      appSecret: '$FEISHU_APP_SECRET',
    });
    expect(result.config?.env).toEqual({ PORT: 43 });
  });

  it('yields config null for a missing file or a non-mapping document', () => {
    const root = mkdtempSync(join(tmpdir(), 'config-raw-'));
    roots.push(root);
    expect(readDiscoveredConfigYaml(join(root, 'missing.yaml'))).toEqual({
      path: join(root, 'missing.yaml'),
      exists: false,
      config: null,
    });
    const list = join(root, 'list.yaml');
    writeFileSync(list, '- just\n- a list\n');
    expect(readDiscoveredConfigYaml(list).config).toBeNull();
  });
});
