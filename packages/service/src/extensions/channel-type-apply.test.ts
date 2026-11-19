import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExtensionSection } from '@disclaude/core';
import type { WiredChannelDescriptor } from '../channel-lifecycle-manager.js';
import { applyChannelTypes, applyChannelTypesForConfigDir } from './channel-type-apply.js';
import { ChannelTypeStore } from './channel-type-store.js';

let configDir: string;
let extensionDir: string;
let warnings: string[];

function validModuleSource(type: string): string {
  return (
    `export default { type: ${JSON.stringify(type)}, name: 'Fixture', `
    + 'factory: () => ({}), createCallbacks: () => () => ({}), createMessageHandler: () => () => {} };\n'
  );
}

/** Registers a fixture module as `type` through the real store (upsert path). */
function registerFixture(type: string, source: string): void {
  const modulePath = join(extensionDir, `${type}.fixture.mjs`);
  writeFileSync(modulePath, source, 'utf8');
  ChannelTypeStore.forConfigDir(configDir).upsert({ type, modulePath });
}

function freshRegistry(): ExtensionSection<WiredChannelDescriptor> {
  return new ExtensionSection<WiredChannelDescriptor>('channelTypeApplyTest');
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'channel-type-apply-'));
  extensionDir = join(configDir, 'extensions');
  mkdirSync(extensionDir, { recursive: true });
  warnings = [];
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe('applyChannelTypes', () => {
  it('applies a valid module with source external', async () => {
    registerFixture('demo', validModuleSource('demo'));
    const registry = freshRegistry();
    const result = await applyChannelTypes(ChannelTypeStore.forConfigDir(configDir), {
      registry,
      warn: (message) => warnings.push(message),
    });
    expect(result).toEqual({ applied: ['demo'], failed: [] });
    expect(warnings).toEqual([]);
    expect(registry.ids()).toEqual(['demo']);
  });

  it('isolates a shape-invalid module from the other records', async () => {
    registerFixture('good', validModuleSource('good'));
    registerFixture('bad-shape', 'export default { type: "bad-shape" };\n');
    registerFixture('wrong-type', validModuleSource('other-type'));
    const registry = freshRegistry();
    const result = await applyChannelTypes(ChannelTypeStore.forConfigDir(configDir), { registry });
    expect(result.applied).toEqual(['good']);
    expect(result.failed.map((entry) => entry.type)).toEqual(['bad-shape', 'wrong-type']);
    expect(result.failed[0].reason).toContain('must be a function');
    expect(result.failed[1].reason).toContain('descriptor type must be "wrong-type"');
    expect(registry.ids()).toEqual(['good']);
  });

  it('isolates a module whose import throws', async () => {
    registerFixture('boom', 'throw new Error("fixture boom");\n');
    registerFixture('good', validModuleSource('good'));
    const registry = freshRegistry();
    const result = await applyChannelTypes(ChannelTypeStore.forConfigDir(configDir), {
      registry,
      warn: (message) => warnings.push(message),
    });
    expect(result.applied).toEqual(['good']);
    expect(result.failed).toEqual([
      { type: 'boom', reason: expect.stringContaining('fixture boom') },
    ]);
    expect(warnings.join('\n')).toContain('Skipping external channel type "boom"');
    expect(registry.ids()).toEqual(['good']);
  });

  it('isolates a duplicate id without disturbing the already-registered entry', async () => {
    registerFixture('dup', validModuleSource('dup'));
    registerFixture('good', validModuleSource('good'));
    const registry = freshRegistry();
    registry.register('dup', {
      type: 'dup',
      name: 'Dup',
      factory: () => ({}),
      createCallbacks: () => () => ({}),
      createMessageHandler: () => () => ({}),
    } as unknown as WiredChannelDescriptor, { source: 'builtin' });
    const result = await applyChannelTypes(ChannelTypeStore.forConfigDir(configDir), { registry });
    expect(result.applied).toEqual(['good']);
    expect(result.failed.map((entry) => entry.type)).toEqual(['dup']);
    expect(result.failed[0].reason).toContain('dup');
    expect(registry.ids().sort()).toEqual(['dup', 'good']);
  });
});

describe('applyChannelTypesForConfigDir', () => {
  it('degrades a corrupt store document to no external types instead of throwing', async () => {
    writeFileSync(join(extensionDir, 'channel-types.json'), '{ not json', 'utf8');
    const result = await applyChannelTypesForConfigDir(configDir, {
      warn: (message) => warnings.push(message),
    });
    expect(result).toEqual({ applied: [], failed: [] });
    expect(warnings.join('\n')).toContain('external channel types skipped');
  });

  it('is a no-op when nothing is registered', async () => {
    const result = await applyChannelTypesForConfigDir(configDir);
    expect(result).toEqual({ applied: [], failed: [] });
  });
});
