import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillsRegistry } from './skills-registry.js';

describe('SkillsRegistry', () => {
  const roots: string[] = [];
  const makeRoot = () => { const root = mkdtempSync(join(tmpdir(), 'skills-registry-')); roots.push(root); return root; };
  const skill = (root: string, name: string, description = 'A useful skill') => {
    mkdirSync(join(root, 'skills', name), { recursive: true });
    writeFileSync(join(root, 'skills', name, 'SKILL.md'), `---\ndescription: ${description}\n---\n`);
  };
  afterEach(() => { while (roots.length) {rmSync(roots.pop()!, { recursive: true, force: true });} });

  it('applies project > user > builtin precedence without leaking absolute paths', () => {
    const builtin = makeRoot(), user = makeRoot(), project = makeRoot();
    skill(builtin, 'demo', 'builtin'); skill(user, 'demo', 'user'); skill(project, 'demo', 'project');
    const resolution = new SkillsRegistry([{ kind: 'builtin', root: builtin }, { kind: 'user', root: user }, { kind: 'project', root: project }]).resolve();
    expect(resolution.skills).toEqual([expect.objectContaining({ name: 'demo', source: 'project', reference: 'skills/demo/SKILL.md', description: 'project' })]);
    expect(resolution.manifest).not.toContain(project);
  });

  it('rejects same-precedence collisions deterministically', () => {
    const first = makeRoot(), second = makeRoot(); skill(first, 'demo'); skill(second, 'demo');
    expect(() => new SkillsRegistry([{ kind: 'project', root: first }, { kind: 'project', root: second }]).resolve()).toThrow('collision');
  });

  it('reuses the revision until eligible skill contents change', () => {
    const root = makeRoot(); skill(root, 'demo', 'first');
    const registry = new SkillsRegistry([{ kind: 'project', root }]);
    const first = registry.resolve();
    expect(registry.resolve()).toBe(first);
    skill(root, 'demo', 'second');
    expect(registry.resolve()).not.toBe(first);
  });

  it('rejects a symlink escape without exposing its absolute target', () => {
    const root = makeRoot(), outside = makeRoot();
    skill(outside, 'escape');
    mkdirSync(join(root, 'skills'), { recursive: true });
    symlinkSync(join(outside, 'skills', 'escape'), join(root, 'skills', 'escape'));
    const resolution = new SkillsRegistry([{ kind: 'project', root }]).resolve();
    expect(resolution.skills).toEqual([]);
    expect(resolution.diagnostics).toContainEqual(expect.objectContaining({ code: 'INVALID_SKILL', detail: expect.not.stringContaining(outside) }));
  });

  it('rejects malformed metadata and bounds manifest descriptions', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'skills', 'unsafe'), { recursive: true });
    writeFileSync(join(root, 'skills', 'unsafe', 'SKILL.md'), '---\ndescription: "[fake](https://bad)"\nunknown: field\n---');
    mkdirSync(join(root, 'skills', 'long'), { recursive: true });
    writeFileSync(join(root, 'skills', 'long', 'SKILL.md'), `---\ndescription: ${'x'.repeat(300)}\n---`);
    const resolution = new SkillsRegistry([{ kind: 'project', root }]).resolve();
    expect(resolution.skills.map((skill) => skill.name)).toEqual(['long']);
    expect(resolution.manifest).not.toContain('fake');
    expect(resolution.manifest.length).toBeLessThan(400);
    expect(resolution.diagnostics).toContainEqual(expect.objectContaining({ name: 'unsafe', code: 'INVALID_SKILL' }));
  });
});
