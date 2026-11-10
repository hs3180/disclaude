// Issue #5745 Part 5: the service bootstrap applies `extensions.<name>`
// declarations BEFORE the validating config load, so an externally-registered
// llmVia type is accepted by loadConfigFile with zero core-code changes
// (acceptance ①, service dimension). Fixture modules are real .mjs files on
// disk so the production dynamic-import chain is exercised, mirroring the
// core loading tests.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyConfiguredExtensions } from './cli-main.js';
import {
  loadConfigFile,
  llmViaRegistry,
  llmProtocolRegistry,
  harnessRegistry,
  unregisterApplied,
  type ExtensionLoadReport,
} from '@disclaude/core';
import { channelTypeRegistry } from './channels/wired-descriptors.js';

const fixtureDir = mkdtempSync(join(tmpdir(), 'disclaude-ext-wiring-'));
const modulePath = join(fixtureDir, 'fake-via.mjs');
writeFileSync(
  modulePath,
  [
    'export function register({ registries }) {',
    "  registries.llmVia.register('fake-via', { protocol: 'anthropic-compatible' });",
    '}',
  ].join('\n')
);

// Minimal config exercising the timing: llms.<name>.via references the
// externally-registered type, so the validating load only passes when the
// pre-scan ran first.
const configPath = join(fixtureDir, 'disclaude.config.yaml');
writeFileSync(
  configPath,
  [
    'extensions:',
    '  fake:',
    `    module: ${JSON.stringify(modulePath)}`,
    '    enabled: true',
    'llms:',
    '  my-llm:',
    '    via: fake-via',
    '',
  ].join('\n')
);

// Isolation: everything registered here is unregistered after the suite, so
// other tests see only built-in sections (same idiom as the core loading tests).
let appliedReports: ExtensionLoadReport[] = [];

afterAll(() => {
  // Only llmVia is registered by the fixture; the full section set matches the
  // ExtensionRegistries shape and unregisterApplied only touches applied ids.
  unregisterApplied(appliedReports, {
    harness: harnessRegistry,
    channelType: channelTypeRegistry,
    llmVia: llmViaRegistry,
    llmProtocol: llmProtocolRegistry,
  });
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('applyConfiguredExtensions (#5745 part 5 wiring)', () => {
  it('registers the declared module so the validating load accepts its llms.via type', async () => {
    expect(llmViaRegistry.has('fake-via')).toBe(false); // pre-state: not built-in
    appliedReports = await applyConfiguredExtensions(configPath);
    expect(appliedReports.map((r) => r.status)).toEqual(['applied']);
    expect(llmViaRegistry.has('fake-via')).toBe(true);

    // The acceptance assertion: the validating loader resolves llms.via
    // against the registry — passes only because extensions were applied first.
    const loaded = loadConfigFile(configPath);
    expect(loaded._fromFile).toBe(true);
    expect(loaded.llms?.['my-llm']?.via).toBe('fake-via');
  });

  it('is a no-op for configs without an extensions section', async () => {
    const plain = join(fixtureDir, 'plain.yaml');
    writeFileSync(plain, 'llms:\n  my-llm:\n    via: fake-via\n');
    const reports = await applyConfiguredExtensions(plain);
    expect(reports).toEqual([]);
  });

  it('leaves an unreadable config to loadConfigFile instead of throwing', async () => {
    const broken = join(fixtureDir, 'broken.yaml');
    writeFileSync(broken, 'extensions: [unclosed');
    const reports = await applyConfiguredExtensions(broken);
    expect(reports).toEqual([]);
  });
});
