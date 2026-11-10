/**
 * Extension module loading tests (Issue #5745 Part 4).
 *
 * Fixtures are real .mjs modules written to a temp dir and loaded through the
 * production dynamic-import path — the same resolution a deployment's
 * `extensions.<name>: { module, enabled: true }` declaration takes.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { DisclaudeConfig } from '../config/types.js';
import { resolveConfiguredAgents } from '../config/resolved-agents.js';
import { llmViaRegistry } from '../config/llm-access.js';
import { getAvailableProviders, harnessRegistry } from '../sdk/factory.js';
import {
  applyExtensionDeclarations,
  unregisterApplied,
  type ExtensionLoadReport,
  type ExtensionRegistries,
} from './loading.js';
import { ExtensionSection } from './registry.js';

const fixtureDir = mkdtempSync(join(tmpdir(), 'disclaude-ext-loading-'));

function writeFixture(name: string, source: string): string {
  const path = join(fixtureDir, name);
  writeFileSync(path, `${source}\n`, 'utf8');
  return `./${name}`;
}

const happySpec = writeFixture(
  'happy.mjs',
  `export default (ctx) => {
    ctx.registries.harness.register('e2e-harness', () => ({
      getInfo: () => ({ name: 'e2e-harness', version: '1.0.0', available: true }),
    }));
    ctx.registries.llmVia.register('e2e-via', { description: 'end-to-end test access method' });
    ctx.registries.channelType.register('e2e-channel', { description: 'end-to-end test channel' });
  };`
);

const namedRegisterSpec = writeFixture(
  'named.mjs',
  `export const register = (ctx) => {
    ctx.registries.llmProtocol.register('e2e-proto', { description: 'end-to-end protocol' });
  };`
);

const partialThrowSpec = writeFixture(
  'partial-throw.mjs',
  `export default (ctx) => {
    ctx.registries.harness.register('e2e-ghost', () => ({ getInfo: () => ({}) }));
    throw new Error('extension exploded');
  };`
);

const noRegisterSpec = writeFixture(
  'no-register.mjs',
  'export const meta = "no register export";'
);

function buildRegistries(): ExtensionRegistries {
  return {
    harness: harnessRegistry,
    channelType: new ExtensionSection<unknown>('channelType.test'),
    llmVia: llmViaRegistry,
    llmProtocol: new ExtensionSection<unknown>('llms.api.protocol.test'),
  };
}

const appliedReports: ExtensionLoadReport[] = [];

afterEach(() => {
  unregisterApplied(appliedReports, appliedRegistries!);
  appliedReports.length = 0;
  // Belt and braces: keep the shared process-level sections pristine even if a
  // report lost attribution (e.g. a rollback-path fixture).
  harnessRegistry.unregister('e2e-harness');
  harnessRegistry.unregister('e2e-ghost');
  llmViaRegistry.unregister('e2e-via');
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

// Rebuilt per test so local sections start empty; the shared sections
// (harness, llmVia) are cleaned by afterEach.
let appliedRegistries: ExtensionRegistries | undefined;

function apply(
  declarations: Record<string, { module?: string; enabled?: boolean }>,
  registries = buildRegistries()
): Promise<ExtensionLoadReport[]> {
  appliedRegistries = registries;
  const result = applyExtensionDeclarations(declarations, {
    configDir: fixtureDir,
    registries,
  });
  return result.then((reports) => {
    appliedReports.push(...reports);
    return reports;
  });
}

describe('applyExtensionDeclarations', () => {
  it('is disabled by default and never imports the module', async () => {
    const reports = await apply({ ghost: { module: './does-not-exist.mjs' } });
    expect(reports).toEqual([
      {
        name: 'ghost',
        module: './does-not-exist.mjs',
        status: 'disabled',
        registeredIds: {},
      },
    ]);
    expect(harnessRegistry.has('ghost')).toBe(false);
  });

  it('rejects an enabled declaration without a usable module string', async () => {
    const reports = await apply({ empty: { enabled: true } });
    expect(reports[0]?.status).toBe('failed');
    expect(reports[0]?.error).toContain('must be a non-empty string');
  });

  it('applies an enabled module across all registry sections (real dynamic import)', async () => {
    const reports = await apply({ happy: { module: happySpec, enabled: true } });
    expect(reports[0]?.status).toBe('applied');
    expect(reports[0]?.registeredIds).toEqual({
      harness: ['e2e-harness'],
      llmVia: ['e2e-via'],
      channelType: ['e2e-channel'],
    });
    // The /agent switching surface enumerates the registry, so a registered
    // harness type is visible with zero core-code changes.
    expect(getAvailableProviders().map((info) => info.name)).toContain('e2e-harness');
    expect(llmViaRegistry.has('e2e-via')).toBe(true);
  });

  it('lets a registered llm.via value pass config validation (Issue #5745 acceptance 1)', async () => {
    const reports = await apply({ happy: { module: happySpec, enabled: true } });
    expect(reports[0]?.status).toBe('applied');
    const config: DisclaudeConfig = {
      agents: { worker: { backend: 'claude', llm: 'e2e' } },
      llms: { e2e: { via: 'e2e-via', defaultModel: 'e2e-model' } },
    };
    expect(resolveConfiguredAgents(config)).toMatchObject({ ok: true });
  });

  it('accepts a named register export', async () => {
    const reports = await apply({ named: { module: namedRegisterSpec, enabled: true } });
    expect(reports[0]?.status).toBe('applied');
    expect(appliedRegistries?.llmProtocol.has('e2e-proto')).toBe(true);
  });

  it('isolates a missing module without touching other declarations', async () => {
    const reports = await apply({
      a: { module: happySpec, enabled: true },
      b: { module: './missing.mjs', enabled: true },
    });
    const byName = Object.fromEntries(reports.map((r) => [r.name, r]));
    expect(byName.a?.status).toBe('applied');
    expect(byName.b?.status).toBe('failed');
    expect(byName.b?.error).toBeTruthy();
    expect(harnessRegistry.has('e2e-harness')).toBe(true);
  });

  it('rolls back partially registered ids when register() throws', async () => {
    const reports = await apply({ boom: { module: partialThrowSpec, enabled: true } });
    expect(reports[0]?.status).toBe('failed');
    expect(reports[0]?.error).toContain('extension exploded');
    expect(harnessRegistry.has('e2e-ghost')).toBe(false);
  });

  it('fails a module without a register contract', async () => {
    const reports = await apply({ nope: { module: noRegisterSpec, enabled: true } });
    expect(reports[0]?.status).toBe('failed');
    expect(reports[0]?.error).toContain('must export a register() function');
  });

  it('re-applies declaratively after unregisterApplied (reload semantics)', async () => {
    const first = await apply({ happy: { module: happySpec, enabled: true } });
    expect(first[0]?.status).toBe('applied');
    const removed = unregisterApplied(first, appliedRegistries!);
    expect(removed).toBe(3);
    expect(harnessRegistry.has('e2e-harness')).toBe(false);

    // Absolute module path takes the same file-URL route.
    const second = await apply({
      happy: { module: resolve(fixtureDir, happySpec.replace('./', '')), enabled: true },
    });
    expect(second[0]?.status).toBe('applied');
    expect(getAvailableProviders().map((info) => info.name)).toContain('e2e-harness');
  });
});
