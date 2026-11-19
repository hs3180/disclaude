import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runChannelTypeCommand, type ChannelTypeCliDeps } from './channel-type-cli.js';
import { BUILTIN_CHANNEL_TYPE_IDS } from './channel-type-store.js';

let configDir: string;
let extensionDir: string;
let stdout: string[];
let stderr: string[];

function deps(): ChannelTypeCliDeps {
  return {
    configDir,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  };
}

function writeModule(name: string, content = 'export default { type: "demo" };\n'): string {
  const modulePath = join(extensionDir, name);
  writeFileSync(modulePath, content, 'utf8');
  return modulePath;
}

function persisted(): unknown {
  return JSON.parse(readFileSync(join(extensionDir, 'channel-types.json'), 'utf8'));
}

function run(args: string[]): number {
  return runChannelTypeCommand(args, deps());
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'channel-type-cli-'));
  extensionDir = join(configDir, 'extensions');
  mkdirSync(extensionDir, { recursive: true });
  stdout = [];
  stderr = [];
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe('channel-type register', () => {
  it('persists an in-extensions-dir module and reports the pending state', () => {
    const modulePath = writeModule('demo-channel.mjs');
    const code = run(['register', 'demo', '--module', modulePath]);
    expect(code).toBe(0);
    expect(stdout.join('\n')).toContain('Registered channel type "demo"');
    expect(stdout.join('\n')).toContain('next `disclaude start`');
    const doc = persisted() as { channelTypes: Record<string, { modulePath: string }> };
    expect(doc.channelTypes.demo.modulePath).toBe(modulePath);
  });

  it('rejects a module path outside the extensions directory', () => {
    const outsideStore = mkdtempSync(join(tmpdir(), 'channel-type-cli-outside-'));
    try {
      const code = run(['register', 'demo', '--module', join(outsideStore, 'elsewhere.mjs')]);
      expect(code).toBe(1);
      expect(stderr.join('\n')).toContain('must resolve inside');
      expect(persisted).toThrow();
    } finally {
      rmSync(outsideStore, { recursive: true, force: true });
    }
  });

  it('is idempotent for an identical module (unchanged no-op)', () => {
    const modulePath = writeModule('demo-channel.mjs');
    expect(run(['register', 'demo', '--module', modulePath])).toBe(0);
    const first = persisted() as { channelTypes: Record<string, { registeredAt: string }> };
    expect(run(['register', 'demo', '--module', modulePath])).toBe(0);
    expect(stdout.join('\n')).toContain('nothing to do');
    const second = persisted() as { channelTypes: Record<string, { registeredAt: string }> };
    expect(second.channelTypes.demo.registeredAt).toBe(first.channelTypes.demo.registeredAt);
  });

  it('conflicts on same type with different content instead of silently replacing', () => {
    const original = writeModule('demo-channel.mjs', 'export default { type: "demo" };\n');
    writeModule('demo-channel-v2.mjs', 'export default { type: "demo", v: 2 };\n');
    expect(run(['register', 'demo', '--module', original])).toBe(0);
    const code = run(['register', 'demo', '--module', join(extensionDir, 'demo-channel-v2.mjs')]);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('refusing to replace');
    const doc = persisted() as { channelTypes: Record<string, { modulePath: string }> };
    expect(doc.channelTypes.demo.modulePath).toBe(original);
  });

  it('rejects built-in ids and a missing/parameter-invalid matrix', () => {
    const modulePath = writeModule('any.mjs');
    expect(run(['register', 'feishu', '--module', modulePath])).toBe(1);
    expect(stderr.join('\n')).toContain('built-in');
    expect(run(['register', 'wechat', '--module', modulePath])).toBe(1);
    expect(run(['register', 'rest', '--module', modulePath])).toBe(1);
    expect(run(['register'])).toBe(1);
    expect(run(['register', 'demo'])).toBe(1);
    expect(run(['register', 'demo', '--module'])).toBe(1);
    expect(run(['register', 'demo', '--module', modulePath, 'extra'])).toBe(1);
    expect(run(['register', 'demo', '--module', modulePath, '--nope'])).toBe(1);
    expect(persisted).toThrow();
  });

  it('stores an optional display name', () => {
    const modulePath = writeModule('demo-channel.mjs');
    expect(run(['register', 'demo', '--module', modulePath, '--name', 'Demo Channel'])).toBe(0);
    const doc = persisted() as { channelTypes: Record<string, { displayName?: string }> };
    expect(doc.channelTypes.demo.displayName).toBe('Demo Channel');
  });
});

describe('channel-type unregister', () => {
  it('removes a persisted external registration', () => {
    const modulePath = writeModule('demo-channel.mjs');
    expect(run(['register', 'demo', '--module', modulePath])).toBe(0);
    expect(run(['unregister', 'demo'])).toBe(0);
    expect(stdout.join('\n')).toContain('Unregistered channel type "demo"');
    expect((persisted() as { channelTypes: Record<string, unknown> }).channelTypes).toEqual({});
  });

  it('refuses built-in ids and unknown types', () => {
    expect(run(['unregister', 'feishu'])).toBe(1);
    expect(run(['unregister', 'demo'])).toBe(1);
    expect(run(['unregister'])).toBe(1);
  });
});

describe('channel-type list', () => {
  it('lists built-ins and external records', () => {
    const modulePath = writeModule('demo-channel.mjs');
    expect(run(['register', 'demo', '--module', modulePath, '--name', 'Demo'])).toBe(0);
    expect(run(['list'])).toBe(0);
    const text = stdout.join('\n');
    for (const id of BUILTIN_CHANNEL_TYPE_IDS) {
      expect(text).toContain(`${id}\tbuiltin`);
    }
    expect(text).toContain('demo (Demo)\texternal');
    expect(text).toContain(modulePath);
  });

  it('supports --json for script consumption', () => {
    const modulePath = writeModule('demo-channel.mjs');
    expect(run(['register', 'demo', '--module', modulePath])).toBe(0);
    stdout = [];
    expect(run(['list', '--json'])).toBe(0);
    const entries = JSON.parse(stdout.join('\n')) as Array<{ type: string; source: string }>;
    expect(entries.filter((entry) => entry.source === 'builtin').map((entry) => entry.type))
      .toEqual([...BUILTIN_CHANNEL_TYPE_IDS]);
    expect(entries.filter((entry) => entry.source === 'external')).toEqual([
      expect.objectContaining({ type: 'demo', modulePath }),
    ]);
  });
});

describe('channel-type usage', () => {
  it('prints usage for no subcommand (exit 1) and help (exit 0)', () => {
    expect(run([])).toBe(1);
    expect(stdout.join('\n')).toContain('Usage:');
    expect(run(['--help'])).toBe(0);
    expect(run(['bogus'])).toBe(1);
    expect(stderr.join('\n')).toContain('Unknown channel-type subcommand: bogus');
  });
});
