import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverBuiltinResources, formatCodexBuiltinContext, mergeBuiltinResources } from './builtin-adapter.js';

describe('Codex builtin adapter (Issue #4699)', () => {
  let root = '';
  afterEach(() => { if (root) {rmSync(root, { recursive: true, force: true });} });

  it('discovers skills and agents without Claude SDK plugin options', () => {
    root = mkdtempSync(join(tmpdir(), 'codex-builtins-'));
    mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
    mkdirSync(join(root, 'agents', 'reviewer'), { recursive: true });
    writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '---\ndescription: Demo skill\n---');
    writeFileSync(join(root, 'agents', 'reviewer', 'reviewer.md'), '---\ndescription: Review agent\n---');
    const resources = discoverBuiltinResources(root);
    expect(resources.map((resource) => resource.name)).toEqual(['demo', 'reviewer']);
    expect(formatCodexBuiltinContext(resources)).toContain('Demo skill');
    expect(formatCodexBuiltinContext(resources)).toContain('reviewer.md');
  });

  it('treats missing builtin directories as an optional capability', () => {
    root = mkdtempSync(join(tmpdir(), 'codex-builtins-empty-'));
    expect(discoverBuiltinResources(root)).toEqual([]);
    expect(formatCodexBuiltinContext([])).toBe('');
  });

  it('merges project and packaged resources without duplicate entries', () => {
    const resource: ReturnType<typeof discoverBuiltinResources>[number] = {
      kind: 'skill', name: 'demo', path: '/workspace/skills/demo/SKILL.md',
    };
    expect(mergeBuiltinResources([resource], [resource])).toEqual([resource]);
  });
});
