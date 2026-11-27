import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_CHANNEL_TYPE_IDS,
  ChannelTypeStore,
  ChannelTypeStoreError,
  type ChannelTypeRecord,
} from './channel-type-store.js';

const hashOf = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex');

let configDir: string;
let moduleDir: string;
let modulePath: string;

function writeModule(content = 'export default { type: "omh" };\n'): void {
  writeFileSync(modulePath, content, 'utf8');
}

function openStore(): ChannelTypeStore {
  return ChannelTypeStore.forConfigDir(configDir);
}

function expectErrorCode(fn: () => unknown, code: ChannelTypeStoreError['code']): ChannelTypeStoreError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ChannelTypeStoreError);
    expect((error as ChannelTypeStoreError).code).toBe(code);
    return error as ChannelTypeStoreError;
  }
  throw new Error('expected function to throw');
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'channel-type-store-'));
  moduleDir = mkdtempSync(join(tmpdir(), 'channel-type-module-'));
  modulePath = join(moduleDir, 'omh-channel.mjs');
  writeModule();
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(moduleDir, { recursive: true, force: true });
});

describe('ChannelTypeStore.upsert', () => {
  it('registers a record and persists it under <configDir>/extensions with owner-only modes', () => {
    const result = openStore().upsert({ type: 'omh', modulePath, displayName: 'OMH' });
    expect(result.status).toBe('registered');
    expect(result.record.type).toBe('omh');
    expect(result.record.modulePath).toBe(modulePath);
    expect(result.record.displayName).toBe('OMH');
    expect(result.record.contentHash).toBe(hashOf('export default { type: "omh" };\n'));
    expect(result.record.moduleMtimeMs).toBe(statSync(modulePath).mtimeMs);

    const storePath = join(configDir, 'extensions', 'channel-types.json');
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
    expect(statSync(join(configDir, 'extensions')).mode & 0o777).toBe(0o700);
    expect(openStore().get('omh')).toEqual(result.record);
  });

  it('re-registering the same module content is a no-op keeping the original record', () => {
    const first = openStore().upsert({ type: 'omh', modulePath });
    const second = openStore().upsert({ type: 'omh', modulePath });
    expect(second.status).toBe('unchanged');
    expect(second.record).toEqual(first.record);
  });

  it('same type with different module content is a conflict listing both hashes and paths', () => {
    openStore().upsert({ type: 'omh', modulePath });
    const changed = 'export default { type: "omh", changed: true };\n';
    writeModule(changed);

    const error = expectErrorCode(() => openStore().upsert({ type: 'omh', modulePath }), 'conflict');
    expect(error.message).toContain('"omh"');
    expect(error.message).toContain(modulePath);
    expect(error.message).toContain(hashOf('export default { type: "omh" };\n'));
    expect(error.message).toContain(hashOf(changed));

    // 错误隔离:冲突注册不改动已持久化条目
    expect(openStore().get('omh')!.contentHash).toBe(hashOf('export default { type: "omh" };\n'));
  });
});

describe('ChannelTypeStore guards', () => {
  it('refuses to override or unregister built-in channel types', () => {
    const store = openStore();
    expectErrorCode(() => store.upsert({ type: BUILTIN_CHANNEL_TYPE_IDS[0], modulePath }), 'reserved');
    expectErrorCode(() => store.remove(BUILTIN_CHANNEL_TYPE_IDS[1]), 'reserved');
    expect(store.list()).toEqual([]);
  });

  it('rejects invalid type ids, relative module paths and unreadable modules', () => {
    const store = openStore();
    expectErrorCode(() => store.upsert({ type: 'OMH', modulePath }), 'invalid');
    expectErrorCode(() => store.upsert({ type: '', modulePath }), 'invalid');
    expectErrorCode(() => store.upsert({ type: 'omh', modulePath: 'relative/omh.mjs' }), 'invalid');
    expectErrorCode(() => store.upsert({ type: 'omh', modulePath: join(moduleDir, 'missing.mjs') }), 'invalid');
    expect(store.list()).toEqual([]);
  });
});

describe('ChannelTypeStore.remove', () => {
  it('removes a registered type and persists the deletion', () => {
    const registered = openStore().upsert({ type: 'omh', modulePath }).record;
    const removed = openStore().remove('omh');
    expect(removed).toEqual(registered);
    expect(openStore().list()).toEqual([]);
    expectErrorCode(() => openStore().remove('omh'), 'unknown');
  });
});

describe('ChannelTypeStore document loading', () => {
  it('fails loudly on a corrupt persisted document instead of dropping registrations', () => {
    mkdirSync(join(configDir, 'extensions'), { recursive: true });
    writeFileSync(join(configDir, 'extensions', 'channel-types.json'), '{not json', 'utf8');
    expect(() => openStore()).toThrow(/Cannot read channel types/);
  });

  it('rejects a persisted record whose modulePath is not absolute', () => {
    openStore().upsert({ type: 'omh', modulePath });
    const storePath = join(configDir, 'extensions', 'channel-types.json');
    const document = JSON.parse(readFileSync(storePath, 'utf8')) as { channelTypes: Record<string, ChannelTypeRecord> };
    document.channelTypes.omh.modulePath = 'relative/omh.mjs';
    writeFileSync(storePath, JSON.stringify(document), 'utf8');
    expect(() => openStore()).toThrow(/Invalid channel types/);
  });
});
