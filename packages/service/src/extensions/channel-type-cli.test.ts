import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runChannelTypeCommand, type ChannelTypeCliDeps } from './channel-type-cli.js';
import { BUILTIN_CHANNEL_TYPE_IDS } from './channel-type-store.js';

let configDir: string;
let extensionDir: string;
let stdout: string[];
let stderr: string[];
let savedBaseUrl: string | undefined;
let savedApiToken: string | undefined;

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

function run(args: string[]): Promise<number> {
  return runChannelTypeCommand(args, deps());
}

/** The notify path talks real fetch; under the global test isolation nock owns
 * the socket layer, so intercept POST /api/channel-types/apply with nock. */
const APPLY_ORIGIN = 'http://disclaude.apply.test';
function applyInterceptor(reply: number, payload: Record<string, unknown>, onBody?: (body: unknown) => void): nock.Scope {
  return nock(APPLY_ORIGIN)
    .post('/api/channel-types/apply', (body) => { onBody?.(body); return true; })
    .reply(reply, payload);
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'channel-type-cli-'));
  extensionDir = join(configDir, 'extensions');
  mkdirSync(extensionDir, { recursive: true });
  stdout = [];
  stderr = [];
  // The notify path falls back to these env vars; scrub them so tests never
  // touch whatever service this process was launched against.
  savedBaseUrl = process.env.DISCLAUDE_API_BASE_URL;
  savedApiToken = process.env.DISCLAUDE_API_TOKEN;
  delete process.env.DISCLAUDE_API_BASE_URL;
  delete process.env.DISCLAUDE_API_TOKEN;
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  if (savedBaseUrl === undefined) { delete process.env.DISCLAUDE_API_BASE_URL; } else { process.env.DISCLAUDE_API_BASE_URL = savedBaseUrl; }
  if (savedApiToken === undefined) { delete process.env.DISCLAUDE_API_TOKEN; } else { process.env.DISCLAUDE_API_TOKEN = savedApiToken; }
});

describe('channel-type register', () => {
  it('persists an in-extensions-dir module and reports the pending state', async () => {
    const modulePath = writeModule('demo-channel.mjs');
    const code = await run(['register', 'demo', '--module', modulePath]);
    expect(code).toBe(0);
    expect(stdout.join('\n')).toContain('Registered channel type "demo"');
    expect(stdout.join('\n')).toContain('next `disclaude start`');
    const doc = persisted() as { channelTypes: Record<string, { modulePath: string }> };
    expect(doc.channelTypes.demo.modulePath).toBe(modulePath);
  });

  it('rejects a module path outside the extensions directory', async () => {
    const outsideStore = mkdtempSync(join(tmpdir(), 'channel-type-cli-outside-'));
    try {
      const code = await run(['register', 'demo', '--module', join(outsideStore, 'elsewhere.mjs')]);
      expect(code).toBe(1);
      expect(stderr.join('\n')).toContain('must resolve inside');
      expect(persisted).toThrow();
    } finally {
      rmSync(outsideStore, { recursive: true, force: true });
    }
  });

  it('is idempotent for an identical module (unchanged no-op)', async () => {
    const modulePath = writeModule('demo-channel.mjs');
    expect(await run(['register', 'demo', '--module', modulePath])).toBe(0);
    const first = persisted() as { channelTypes: Record<string, { registeredAt: string }> };
    expect(await run(['register', 'demo', '--module', modulePath])).toBe(0);
    expect(stdout.join('\n')).toContain('nothing to do');
    const second = persisted() as { channelTypes: Record<string, { registeredAt: string }> };
    expect(second.channelTypes.demo.registeredAt).toBe(first.channelTypes.demo.registeredAt);
  });

  it('conflicts on same type with different content instead of silently replacing', async () => {
    const original = writeModule('demo-channel.mjs', 'export default { type: "demo" };\n');
    writeModule('demo-channel-v2.mjs', 'export default { type: "demo", v: 2 };\n');
    expect(await run(['register', 'demo', '--module', original])).toBe(0);
    const code = await run(['register', 'demo', '--module', join(extensionDir, 'demo-channel-v2.mjs')]);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('refusing to replace');
    const doc = persisted() as { channelTypes: Record<string, { modulePath: string }> };
    expect(doc.channelTypes.demo.modulePath).toBe(original);
  });

  it('rejects built-in ids and a missing/parameter-invalid matrix', async () => {
    const modulePath = writeModule('any.mjs');
    expect(await run(['register', 'feishu', '--module', modulePath])).toBe(1);
    expect(stderr.join('\n')).toContain('built-in');
    expect(await run(['register', 'wechat', '--module', modulePath])).toBe(1);
    expect(await run(['register', 'rest', '--module', modulePath])).toBe(1);
    expect(await run(['register'])).toBe(1);
    expect(await run(['register', 'demo'])).toBe(1);
    expect(await run(['register', 'demo', '--module'])).toBe(1);
    expect(await run(['register', 'demo', '--module', modulePath, 'extra'])).toBe(1);
    expect(await run(['register', 'demo', '--module', modulePath, '--nope'])).toBe(1);
    expect(persisted).toThrow();
  });

  it('stores an optional display name', async () => {
    const modulePath = writeModule('demo-channel.mjs');
    expect(await run(['register', 'demo', '--module', modulePath, '--name', 'Demo Channel'])).toBe(0);
    const doc = persisted() as { channelTypes: Record<string, { displayName?: string }> };
    expect(doc.channelTypes.demo.displayName).toBe('Demo Channel');
  });
});

describe('channel-type unregister', () => {
  it('removes a persisted external registration', async () => {
    const modulePath = writeModule('demo-channel.mjs');
    expect(await run(['register', 'demo', '--module', modulePath])).toBe(0);
    expect(await run(['unregister', 'demo'])).toBe(0);
    expect(stdout.join('\n')).toContain('Unregistered channel type "demo"');
    expect((persisted() as { channelTypes: Record<string, unknown> }).channelTypes).toEqual({});
  });

  it('refuses built-in ids and unknown types', async () => {
    expect(await run(['unregister', 'feishu'])).toBe(1);
    expect(await run(['unregister', 'demo'])).toBe(1);
    expect(await run(['unregister'])).toBe(1);
  });
});

describe('channel-type list', () => {
  it('lists built-ins and external records', async () => {
    const modulePath = writeModule('demo-channel.mjs');
    expect(await run(['register', 'demo', '--module', modulePath, '--name', 'Demo'])).toBe(0);
    expect(await run(['list'])).toBe(0);
    const text = stdout.join('\n');
    for (const id of BUILTIN_CHANNEL_TYPE_IDS) {
      expect(text).toContain(`${id}\tbuiltin`);
    }
    expect(text).toContain('demo (Demo)\texternal');
    expect(text).toContain(modulePath);
  });

  it('supports --json for script consumption', async () => {
    const modulePath = writeModule('demo-channel.mjs');
    expect(await run(['register', 'demo', '--module', modulePath])).toBe(0);
    stdout = [];
    expect(await run(['list', '--json'])).toBe(0);
    const entries = JSON.parse(stdout.join('\n')) as Array<{ type: string; source: string }>;
    expect(entries.filter((entry) => entry.source === 'builtin').map((entry) => entry.type))
      .toEqual([...BUILTIN_CHANNEL_TYPE_IDS]);
    expect(entries.filter((entry) => entry.source === 'external')).toEqual([
      expect.objectContaining({ type: 'demo', modulePath }),
    ]);
  });
});

describe('channel-type usage', () => {
  it('prints usage for no subcommand (exit 1) and help (exit 0)', async () => {
    expect(await run([])).toBe(1);
    expect(stdout.join('\n')).toContain('Usage:');
    expect(await run(['--help'])).toBe(0);
    expect(await run(['bogus'])).toBe(1);
    expect(stderr.join('\n')).toContain('Unknown channel-type subcommand: bogus');
  });
});

describe('register/unregister hot-notify (#5745 r2 S4b)', () => {
  it('asks the running service at --base-url to apply, with bearer auth', async () => {
    let seenBody: unknown;
    const scope = nock(APPLY_ORIGIN)
      .matchHeader('content-type', 'application/json')
      .matchHeader('authorization', /^Bearer ?$/)
      .post('/api/channel-types/apply', (body) => { seenBody = body; return true; })
      .reply(200, { ok: true, applied: ['demo'], failed: [] });
    const modulePath = writeModule('demo-channel.mjs');
    const code = await run(['register', 'demo', '--module', modulePath, '--base-url', APPLY_ORIGIN]);
    expect(code).toBe(0);
    expect(scope.isDone()).toBe(true);
    expect(seenBody).toEqual({});
    expect(stdout.join('\n')).toContain('Running service applied 1 channel type(s).');
    expect(stdout.join('\n')).toContain('Registered channel type "demo"');
  });

  it('falls back to DISCLAUDE_API_BASE_URL and surfaces per-record failures', async () => {
    applyInterceptor(200, { ok: true, applied: [], failed: [{ type: 'demo', reason: 'boom' }] });
    process.env.DISCLAUDE_API_BASE_URL = APPLY_ORIGIN;
    const modulePath = writeModule('demo-channel.mjs');
    expect(await run(['register', 'demo', '--module', modulePath])).toBe(0);
    expect(stdout.join('\n')).toContain('Running service applied 0 channel type(s).');
    expect(stderr.join('\n')).toContain('failure(s) for: demo');
    applyInterceptor(200, { ok: true, applied: [], failed: [] });
    expect(await run(['unregister', 'demo', '--base-url', APPLY_ORIGIN])).toBe(0);
    expect(stdout.join('\n')).toContain('Unregistered channel type "demo"');
    expect(persisted()).toBeTruthy();
  });

  it('treats an unreachable service as non-fatal', async () => {
    nock(APPLY_ORIGIN)
      .post('/api/channel-types/apply')
      .replyWithError({ code: 'ECONNREFUSED' });
    const modulePath = writeModule('demo-channel.mjs');
    expect(await run(['register', 'demo', '--module', modulePath, '--base-url', APPLY_ORIGIN])).toBe(0);
    expect(stderr.join('\n')).toContain('Could not notify the running service');
    expect(stderr.join('\n')).toContain('next `disclaude start`');
    expect(persisted()).toBeTruthy();
  });

  it('treats a non-ok apply response as non-fatal', async () => {
    applyInterceptor(503, { ok: false });
    const modulePath = writeModule('demo-channel.mjs');
    expect(await run(['register', 'demo', '--module', modulePath, '--base-url', APPLY_ORIGIN])).toBe(0);
    expect(stderr.join('\n')).toContain('HTTP 503');
    expect(stderr.join('\n')).toContain('next `disclaude start`');
  });

  it('notes the pending state when no base URL is available', async () => {
    const modulePath = writeModule('demo-channel.mjs');
    expect(await run(['register', 'demo', '--module', modulePath])).toBe(0);
    expect(stderr.join('\n')).toContain('No running service notified');
    expect(stderr.join('\n')).toContain('next `disclaude start`');
  });
});
