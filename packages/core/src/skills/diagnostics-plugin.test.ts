import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  diagnosticsPluginManifest,
  diagnosticsPluginRoot,
  manageDiagnosticsPlugin,
} from './diagnostics-plugin.js';
import { codexSkillsRegistry } from '../sdk/providers/codex/skill-sources.js';
import { adaptOptions } from '../sdk/providers/claude/options-adapter.js';

const roots: string[] = [];
const builtin = resolve('.');
function project() {
  const root = mkdtempSync(join(tmpdir(), 'disclaude-diagnostics-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('optional first-party diagnostics plugin', () => {
  it('keeps clean defaults absent from all adapters and list read-only', () => {
    const root = project();
    expect(manageDiagnosticsPlugin('list', root, builtin)).toMatchObject({
      installed: false,
      plugin: 'diagnostics',
    });
    expect(existsSync(join(root, '.disclaude'))).toBe(false);
    expect(existsSync(join(builtin, 'skills/diagnose-logs'))).toBe(false);
    expect(codexSkillsRegistry(root, builtin).resolve().manifest).not.toContain('diagnose-logs');
    expect(diagnosticsPluginManifest(root)).toBe('');
    expect(adaptOptions({ cwd: root, settingSources: [] }).plugins).toHaveLength(1);
  });

  it('installs offline, exposes readable instructions to all adapters, and removes only its own directory', () => {
    const root = project();
    const execution = join(root, 'nested execution');
    mkdirSync(execution);
    const registry = codexSkillsRegistry(root, builtin, execution);
    expect(registry.resolve().manifest).not.toContain('diagnose-logs');
    expect(manageDiagnosticsPlugin('install', root, builtin)).toMatchObject({
      installed: true,
      changed: true,
    });
    const plugin = diagnosticsPluginRoot(root);
    const result = registry.resolve();
    const { reference } = result.skills.find((skill) => skill.name === 'diagnose-logs')!;
    const content = readFileSync(resolve(execution, reference), 'utf8');
    expect(content).toContain('Disclaude service issues only');
    expect(result.diagnostics).toEqual([]);
    expect(diagnosticsPluginManifest(root, execution)).toContain(reference);
    expect(
      adaptOptions({ cwd: execution, projectRoot: root, settingSources: [] }).plugins
    ).toContainEqual({ type: 'local', path: plugin });
    expect(manageDiagnosticsPlugin('install', root, builtin)).toMatchObject({ changed: false });
    expect(manageDiagnosticsPlugin('update', root, builtin)).toMatchObject({ changed: false });
    writeFileSync(join(root, 'user-data.txt'), 'keep');
    expect(manageDiagnosticsPlugin('remove', root, builtin)).toMatchObject({
      installed: false,
      changed: true,
    });
    expect(registry.resolve().manifest).not.toContain('diagnose-logs');
    expect(diagnosticsPluginManifest(root)).toBe('');
    expect(adaptOptions({ cwd: root, settingSources: [] }).plugins).toHaveLength(1);
    expect(readFileSync(join(root, 'user-data.txt'), 'utf8')).toBe('keep');
    expect(manageDiagnosticsPlugin('remove', root, builtin)).toMatchObject({ changed: false });
  });

  it('updates from the current release without silently replacing an older install', () => {
    const root = project();
    const release = project();
    const bundle = join(release, 'optional-plugins/diagnostics');
    mkdirSync(join(bundle, '.claude-plugin'), { recursive: true });
    mkdirSync(join(bundle, 'skills/diagnose-logs'), { recursive: true });
    writeFileSync(
      join(bundle, '.claude-plugin/plugin.json'),
      '{"name":"disclaude-diagnostics","version":"2.0.0"}'
    );
    writeFileSync(
      join(bundle, 'skills/diagnose-logs/SKILL.md'),
      '---\nname: diagnose-logs\ndescription: Disclaude service issues\n---\nUpdated instructions'
    );
    manageDiagnosticsPlugin('install', root, builtin);
    expect(() => manageDiagnosticsPlugin('install', root, release)).toThrow(
      'plugins update diagnostics'
    );
    expect(manageDiagnosticsPlugin('update', root, release)).toMatchObject({
      version: '2.0.0',
      changed: true,
    });
    expect(
      readFileSync(join(diagnosticsPluginRoot(root), 'skills/diagnose-logs/SKILL.md'), 'utf8')
    ).toContain('Updated instructions');
    expect(() => manageDiagnosticsPlugin('update', project(), release)).toThrow('not installed');
  });

  it.each(['edited', 'extra', 'missing', 'symlink', 'unowned'])(
    'preserves %s content instead of replacing or deleting it',
    (kind) => {
      const root = project();
      manageDiagnosticsPlugin('install', root, builtin);
      const plugin = diagnosticsPluginRoot(root);
      const skill = join(plugin, 'skills/diagnose-logs/SKILL.md');
      if (kind === 'edited') {
        writeFileSync(skill, 'user edits');
      }
      if (kind === 'extra') {
        writeFileSync(join(plugin, 'notes.txt'), 'user data');
      }
      if (kind === 'missing') {
        rmSync(skill);
      }
      if (kind === 'symlink') {
        rmSync(skill);
        symlinkSync(
          join(builtin, 'optional-plugins/diagnostics/skills/diagnose-logs/SKILL.md'),
          skill
        );
      }
      if (kind === 'unowned') {
        rmSync(join(plugin, '.disclaude-install.json'));
      }
      for (const command of ['update', 'remove'] as const) {
        expect(() => manageDiagnosticsPlugin(command, root, builtin)).toThrow();
        expect(existsSync(plugin)).toBe(true);
      }
    }
  );

  it('rejects symlinked project metadata and competing operations', () => {
    const root = project();
    const outside = project();
    symlinkSync(outside, join(root, '.disclaude'));
    expect(() => manageDiagnosticsPlugin('install', root, builtin)).toThrow('real directory');
    expect(existsSync(join(outside, 'plugins'))).toBe(false);
    rmSync(join(root, '.disclaude'));
    mkdirSync(join(root, '.disclaude/plugins/.diagnostics.lock'), { recursive: true });
    expect(() => manageDiagnosticsPlugin('install', root, builtin)).toThrow('already in progress');
  });
});
