import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigEnvironment } from './discovery.js';

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
