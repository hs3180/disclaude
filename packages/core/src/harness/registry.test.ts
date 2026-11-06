/**
 * Tests for the harness catalog: id/alias resolution and version precedence.
 */

import { describe, expect, it } from 'vitest';
import {
  HARNESS_IDS,
  harnessCatalog,
  harnessVersionEnvKey,
  nodeSatisfiesPi,
  PI_RUNTIME_PACKAGES,
  resolveHarnessId,
  resolveHarnessVersion,
} from './registry.js';

describe('resolveHarnessId', () => {
  it('accepts every catalog id and normalizes case and whitespace', () => {
    expect(resolveHarnessId('claude')).toBe('claude');
    expect(resolveHarnessId(' pi ')).toBe('pi');
    expect(resolveHarnessId('Codex')).toBe('codex');
    expect(resolveHarnessId('DSH')).toBe('dsh');
  });

  it('maps the deepseek alias to dsh', () => {
    expect(resolveHarnessId('deepseek')).toBe('dsh');
    expect(resolveHarnessId('DeepSeek')).toBe('dsh');
  });

  it('rejects unknown harnesses', () => {
    expect(resolveHarnessId('gemini')).toBeUndefined();
    expect(resolveHarnessId('')).toBeUndefined();
  });
});

describe('harness catalog invariants', () => {
  it('covers exactly claude, pi, codex and dsh', () => {
    expect(HARNESS_IDS).toEqual(['claude', 'pi', 'codex', 'dsh']);
  });

  it('gives every harness a documented install target, packages and version source', () => {
    for (const id of HARNESS_IDS) {
      const entry = harnessCatalog(id);
      expect(['path-cli', 'node-modules']).toContain(entry.installTarget);
      expect(entry.packages.length).toBeGreaterThan(0);
      expect(entry.versionSource).toBeTruthy();
      expect(entry.docs).toMatch(/^docs\//);
      expect(entry.auth.nextStep).toBeTruthy();
      if (entry.installTarget === 'path-cli') {
        expect(entry.binaries.length).toBe(1);
        expect(entry.pinnedVersion ?? id).toBeTruthy();
        if (id !== 'claude') {
          expect(entry.pinnedVersion).toMatch(/^\d/);
        }
      } else {
        expect(entry.binaries).toEqual([]);
        expect(entry.pinnedVersion).toBe('0.83.0');
        expect(entry.packages).toEqual([...PI_RUNTIME_PACKAGES]);
      }
    }
  });
});

describe('resolveHarnessVersion precedence', () => {
  it('prefers the --version flag over environment and repo pins', () => {
    const resolved = resolveHarnessVersion('codex', {
      flagVersion: '0.199.0',
      env: { DISCLAUDE_HARNESS_CODEX_VERSION: '0.160.0' },
    });
    expect(resolved).toEqual({ value: '0.199.0', source: '--version flag', overridden: 'flag' });
  });

  it('honors the documented environment override key', () => {
    const resolved = resolveHarnessVersion('dsh', {
      env: { DISCLAUDE_HARNESS_DSH_VERSION: ' 0.2.0 ' },
    });
    expect(resolved).toEqual({
      value: '0.2.0',
      source: 'environment DISCLAUDE_HARNESS_DSH_VERSION',
      overridden: 'env',
    });
    expect(harnessVersionEnvKey('dsh')).toBe('DISCLAUDE_HARNESS_DSH_VERSION');
  });

  it('still honors the legacy DISCLAUDE_BACKEND_<ID>_VERSION key, labeled and outranked', () => {
    expect(
      resolveHarnessVersion('pi', { env: { DISCLAUDE_BACKEND_PI_VERSION: '0.84.0' } })
    ).toEqual({
      value: '0.84.0',
      source:
        'environment DISCLAUDE_BACKEND_PI_VERSION (legacy alias of DISCLAUDE_HARNESS_PI_VERSION)',
      overridden: 'env',
    });
    expect(
      resolveHarnessVersion('pi', {
        env: {
          DISCLAUDE_BACKEND_PI_VERSION: '0.84.0',
          DISCLAUDE_HARNESS_PI_VERSION: '0.85.0',
        },
      }).value
    ).toBe('0.85.0');
  });

  it('falls back to the repo pin with its source', () => {
    expect(resolveHarnessVersion('codex', {})).toEqual({
      value: '0.154.0',
      source: 'Dockerfile.service ARG CODEX_VERSION (image build pin)',
      overridden: false,
    });
    expect(resolveHarnessVersion('pi', {}).value).toBe('0.83.0');
  });

  it('defaults claude to the bundled SDK Claude Code version', () => {
    expect(resolveHarnessVersion('claude', { claudeBundledVersion: '2.1.263' })).toEqual({
      value: '2.1.263',
      source: expect.stringContaining('claude-agent-sdk'),
      overridden: false,
    });
  });

  it('labels the claude fallback when the bundled manifest is unavailable', () => {
    expect(resolveHarnessVersion('claude', {})).toEqual({
      value: 'latest',
      source: expect.stringContaining('latest'),
      overridden: false,
    });
  });
});

describe('nodeSatisfiesPi', () => {
  it('accepts versions at or above 22.19.0', () => {
    expect(nodeSatisfiesPi('v22.19.0')).toBe(true);
    expect(nodeSatisfiesPi('v22.23.4')).toBe(true);
    expect(nodeSatisfiesPi('v23.0.0')).toBe(true);
  });

  it('rejects older or unparseable versions', () => {
    expect(nodeSatisfiesPi('v22.18.9')).toBe(false);
    expect(nodeSatisfiesPi('v21.7.1')).toBe(false);
    expect(nodeSatisfiesPi('not-a-version')).toBe(false);
    expect(nodeSatisfiesPi('')).toBe(false);
  });
});
