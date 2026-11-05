/**
 * Tests for the backend catalog: id/alias resolution and version precedence.
 */

import { describe, expect, it } from 'vitest';
import {
  BACKEND_IDS,
  backendCatalog,
  backendVersionEnvKey,
  nodeSatisfiesPi,
  PI_RUNTIME_PACKAGES,
  resolveBackendId,
  resolveBackendVersion,
} from './registry.js';

describe('resolveBackendId', () => {
  it('accepts every catalog id and normalizes case and whitespace', () => {
    expect(resolveBackendId('claude')).toBe('claude');
    expect(resolveBackendId(' pi ')).toBe('pi');
    expect(resolveBackendId('Codex')).toBe('codex');
    expect(resolveBackendId('DSH')).toBe('dsh');
  });

  it('maps the deepseek alias to dsh', () => {
    expect(resolveBackendId('deepseek')).toBe('dsh');
    expect(resolveBackendId('DeepSeek')).toBe('dsh');
  });

  it('rejects unknown backends', () => {
    expect(resolveBackendId('gemini')).toBeUndefined();
    expect(resolveBackendId('')).toBeUndefined();
  });
});

describe('backend catalog invariants', () => {
  it('covers exactly claude, pi, codex and dsh', () => {
    expect(BACKEND_IDS).toEqual(['claude', 'pi', 'codex', 'dsh']);
  });

  it('gives every backend a documented install target, packages and version source', () => {
    for (const id of BACKEND_IDS) {
      const entry = backendCatalog(id);
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

describe('resolveBackendVersion precedence', () => {
  it('prefers the --version flag over environment and repo pins', () => {
    const resolved = resolveBackendVersion('codex', {
      flagVersion: '0.199.0',
      env: { DISCLAUDE_BACKEND_CODEX_VERSION: '0.160.0' },
    });
    expect(resolved).toEqual({ value: '0.199.0', source: '--version flag', overridden: 'flag' });
  });

  it('honors the documented environment override key', () => {
    const resolved = resolveBackendVersion('dsh', {
      env: { DISCLAUDE_BACKEND_DSH_VERSION: ' 0.2.0 ' },
    });
    expect(resolved).toEqual({
      value: '0.2.0',
      source: 'environment DISCLAUDE_BACKEND_DSH_VERSION',
      overridden: 'env',
    });
    expect(backendVersionEnvKey('dsh')).toBe('DISCLAUDE_BACKEND_DSH_VERSION');
  });

  it('falls back to the repo pin with its source', () => {
    expect(resolveBackendVersion('codex', {})).toEqual({
      value: '0.154.0',
      source: 'Dockerfile.service ARG CODEX_VERSION (image build pin)',
      overridden: false,
    });
    expect(resolveBackendVersion('pi', {}).value).toBe('0.83.0');
  });

  it('defaults claude to the bundled SDK Claude Code version', () => {
    expect(resolveBackendVersion('claude', { claudeBundledVersion: '2.1.263' })).toEqual({
      value: '2.1.263',
      source: expect.stringContaining('claude-agent-sdk'),
      overridden: false,
    });
  });

  it('labels the claude fallback when the bundled manifest is unavailable', () => {
    expect(resolveBackendVersion('claude', {})).toEqual({
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
