import { mkdir, mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { manageDiagnosticsPlugin } from '../../../skills/diagnostics-plugin.js';
import {
  DISCLAUDE_DSH_SKILL_PROVIDER,
  dshSkillPlan,
  registerDisclaudeSkills,
  type DshSkillCandidate,
  type DshSkillProvider,
  type DshSkillRegistryLike,
} from './dsh-skills.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `dsh-skills-${label}-`));
  directories.push(directory);
  return directory;
}

async function writeSkill(root: string, name: string, body: string): Promise<void> {
  await mkdir(join(root, 'skills', name), { recursive: true });
  await writeFile(
    join(root, 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Skill ${name}\n---\n\n${body}\n`
  );
}

async function listedSkills(provider: DshSkillProvider): Promise<DshSkillCandidate[]> {
  return (await provider.list({})) as unknown as DshSkillCandidate[];
}

function fakeRegistry(): {
  registry: DshSkillRegistryLike;
  providers: DshSkillProvider[];
  disposed: number;
} {
  const providers: DshSkillProvider[] = [];
  const state = { disposed: 0 };
  const registry: DshSkillRegistryLike = {
    registerProvider: (create) => {
      const provider = create({ signal: new AbortController().signal, invalidate: () => {} });
      providers.push(provider);
      return () => {
        state.disposed += 1;
      };
    },
  };
  return { registry, providers, disposed: state.disposed };
}

describe('Disclaude skills on the DSH native registry (#5717)', () => {
  it('lists built-in skills as one DSH provider with bundled-rank candidates', async () => {
    const builtins = await tempDirectory('builtins');
    await writeSkill(builtins, 'channel', 'Deliver through the running service.');
    const { registry, providers } = fakeRegistry();
    const registration = registerDisclaudeSkills(registry, dshSkillPlan(undefined, builtins), vi.fn());
    expect(providers).toHaveLength(1);
    expect(providers[0].name).toBe(DISCLAUDE_DSH_SKILL_PROVIDER);
    expect(registration.skills).toBe(1);
    const listed = await listedSkills(providers[0]);
    expect(listed).toEqual([
      expect.objectContaining({
        name: 'channel',
        description: 'Skill channel',
        provider: 'disclaude',
        source: 'disclaude',
        rank: 600,
        invocation: { modelInvocable: true, userInvocable: false },
        resourceBase: { kind: 'directory', path: join(builtins, 'skills', 'channel') },
        path: join(builtins, 'skills', 'channel', 'SKILL.md'),
      }),
    ]);
  });

  it('loads the instruction body through the shared strict frontmatter parser', async () => {
    const builtins = await tempDirectory('builtins');
    await writeSkill(builtins, 'channel', 'Deliver through the running service.');
    const { registry, providers } = fakeRegistry();
    registerDisclaudeSkills(registry, dshSkillPlan(undefined, builtins), vi.fn());
    const [candidate] = await listedSkills(providers[0]);
    const definition = await providers[0].get(candidate, {});
    expect(definition).toMatchObject({
      name: 'channel',
      provider: 'disclaude',
      content: 'Deliver through the running service.',
    });
  });

  it('includes the diagnostics skill only through its explicit installation', async () => {
    const builtins = await tempDirectory('builtins');
    await writeSkill(builtins, 'channel', 'Built-in body.');
    const project = await tempDirectory('project');
    const { registry, providers } = fakeRegistry();
    const warn = vi.fn();

    // Without an installation: built-ins alone.
    let registration = registerDisclaudeSkills(registry, dshSkillPlan(project, builtins), warn);
    expect(registration.skills).toBe(1);

    // Explicitly installed: the diagnostics skill joins the same provider.
    manageDiagnosticsPlugin('install', project, resolve('.'));
    registration = registerDisclaudeSkills(registry, dshSkillPlan(project, builtins), warn);
    expect(registration.skills).toBe(2);
    const listed = await listedSkills(providers.at(-1)!);
    expect(listed.map((skill) => skill.name).sort()).toEqual(['channel', 'diagnose-logs']);

    // An edited installation grants nothing (receipt boundary re-validated
    // in-process from projectRoot, exactly like the host-side check). The
    // tampered install is left for the temp-dir cleanup: the manager refuses
    // to touch edited content by design.
    await appendFile(join(project, '.disclaude', 'plugins', 'diagnostics', 'skills', 'diagnose-logs', 'SKILL.md'), '\ntampered\n');
    registration = registerDisclaudeSkills(registry, dshSkillPlan(project, builtins), warn);
    expect(registration.skills).toBe(1);
  });

  it('drops names outside the DSH public grammar instead of failing the catalog', async () => {
    const builtins = await tempDirectory('builtins');
    await writeSkill(builtins, 'channel', 'Body.');
    await writeSkill(builtins, 'legacy_name', 'Undeliverable on DSH.');
    const { registry, providers } = fakeRegistry();
    const warn = vi.fn();
    const registration = registerDisclaudeSkills(registry, dshSkillPlan(undefined, builtins), warn);
    expect(registration.skills).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      'skill "legacy_name" is not a valid DSH skill name and stays unlisted'
    );
    const listed = await listedSkills(providers[0]);
    expect(listed.map((skill) => skill.name)).toEqual(['channel']);
  });

  it('keeps the plan explicit: no project root means no diagnostics lookup', async () => {
    const builtins = await tempDirectory('builtins');
    await writeSkill(builtins, 'channel', 'Body.');
    const { registry } = fakeRegistry();
    const plan = dshSkillPlan(undefined, builtins);
    expect(plan).toEqual({ builtinRoot: builtins });
    const registration = registerDisclaudeSkills(registry, dshSkillPlan(undefined, builtins), vi.fn());
    expect(registration.skills).toBe(1);
    expect(registration.dispose).toBeInstanceOf(Function);
  });

  it('round-trips a repo-shaped skill with extended frontmatter end to end', async () => {
    const builtins = await tempDirectory('builtins');
    await mkdir(join(builtins, 'skills', 'schedule'), { recursive: true });
    await writeFile(
      join(builtins, 'skills', 'schedule', 'SKILL.md'),
      '---\nname: schedule\ndescription: Manage recurring background work through SCHEDULE.md files.\nallowed-tools: Bash, Read, Write\n---\n\n# Schedule\n\nRecurring work lives in schedules/<slug>/SCHEDULE.md.\n'
    );
    const { registry, providers } = fakeRegistry();
    const registration = registerDisclaudeSkills(registry, dshSkillPlan(undefined, builtins), vi.fn());
    expect(registration.skills).toBe(1);
    const [candidate] = await listedSkills(providers[0]);
    const definition = await providers[0].get(candidate, {});
    expect(definition?.description).toBe('Manage recurring background work through SCHEDULE.md files.');
    expect(definition?.content).toContain('# Schedule');
    expect(definition?.content).not.toContain('allowed-tools');
  });
});
