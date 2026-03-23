/**
 * Tests for SkillFinder module.
 *
 * Uses temporary directories and custom searchPaths to avoid depending on
 * Config or getDefaultSearchPaths.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { findSkill, listSkills, skillExists, readSkillContent } from './finder.js';
import type { SkillSearchPath, DiscoveredSkill } from './finder.js';

vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  })),
}));

vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: vi.fn(() => '/test/workspace'),
    getSkillsDir: vi.fn(() => '/test/skills'),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'skill-finder-test-'));
}

/**
 * Create a SKILL.md file inside `baseDir/<skillName>/SKILL.md` with the
 * given content.
 */
async function createSkill(
  baseDir: string,
  skillName: string,
  content: string = `# ${skillName}\nDefault content.`
): Promise<string> {
  const skillDir = path.join(baseDir, skillName);
  await fs.mkdir(skillDir, { recursive: true });
  const skillFile = path.join(skillDir, 'SKILL.md');
  await fs.writeFile(skillFile, content, 'utf-8');
  return skillFile;
}

/** Build a searchPaths array from a list of { dir, domain, priority }. */
function searchPaths(
  entries: Array<{ dir: string; domain: 'project' | 'workspace' | 'package'; priority: number }>
): SkillSearchPath[] {
  return entries.map(e => ({ path: e.dir, domain: e.domain, priority: e.priority }));
}

// ---------------------------------------------------------------------------
// findSkill
// ---------------------------------------------------------------------------

describe('findSkill', () => {
  it('returns the path when a skill exists in the only search path', async () => {
    const dir = await makeTempDir();
    const skillFile = await createSkill(dir, 'deployer');
    const result = await findSkill('deployer', searchPaths([{ dir, domain: 'project', priority: 1 }]));

    expect(result).toBe(skillFile);
  });

  it('returns null when the skill does not exist in any search path', async () => {
    const dir = await makeTempDir();
    const result = await findSkill('nonexistent', searchPaths([{ dir, domain: 'project', priority: 1 }]));

    expect(result).toBeNull();
  });

  it('searches paths in priority order and returns the first (highest priority) match', async () => {
    const highDir = await makeTempDir();
    const lowDir = await makeTempDir();

    const highFile = await createSkill(highDir, 'linter', 'High priority linter');
    await createSkill(lowDir, 'linter', 'Low priority linter');

    // Pass paths sorted highest-priority first (as the production code expects).
    const paths = searchPaths([
      { dir: highDir, domain: 'project', priority: 10 },
      { dir: lowDir, domain: 'package', priority: 1 },
    ]);

    const result = await findSkill('linter', paths);
    expect(result).toBe(highFile);
  });

  it('falls through to a lower-priority path when the skill is missing from higher-priority paths', async () => {
    const highDir = await makeTempDir(); // no skills here
    const lowDir = await makeTempDir();

    const lowFile = await createSkill(lowDir, 'formatter');

    const paths = searchPaths([
      { dir: highDir, domain: 'project', priority: 10 },
      { dir: lowDir, domain: 'package', priority: 1 },
    ]);

    const result = await findSkill('formatter', paths);
    expect(result).toBe(lowFile);
  });

  it('gracefully handles a non-existent search directory', async () => {
    const dir = await makeTempDir();
    const fakeDir = path.join(dir, 'does-not-exist');

    const result = await findSkill(
      'anything',
      searchPaths([{ dir: fakeDir, domain: 'workspace', priority: 1 }])
    );

    expect(result).toBeNull();
  });

  it('ignores directories that lack a SKILL.md file', async () => {
    const dir = await makeTempDir();
    // Create a subdirectory but no SKILL.md inside it
    await fs.mkdir(path.join(dir, 'empty-skill'), { recursive: true });

    const result = await findSkill('empty-skill', searchPaths([{ dir, domain: 'project', priority: 1 }]));
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listSkills
// ---------------------------------------------------------------------------

describe('listSkills', () => {
  it('lists skills from a single search path', async () => {
    const dir = await makeTempDir();
    await createSkill(dir, 'alpha');
    await createSkill(dir, 'beta');

    const skills = await listSkills(searchPaths([{ dir, domain: 'project', priority: 1 }]));

    const names = skills.map(s => s.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
  });

  it('returns an empty array when no skills are found', async () => {
    const dir = await makeTempDir();
    const skills = await listSkills(searchPaths([{ dir, domain: 'project', priority: 1 }]));
    expect(skills).toEqual([]);
  });

  it('aggregates skills from multiple search paths', async () => {
    const dirA = await makeTempDir();
    const dirB = await makeTempDir();

    await createSkill(dirA, 'skill-a');
    await createSkill(dirB, 'skill-b');

    const skills = await listSkills(
      searchPaths([
        { dir: dirA, domain: 'project', priority: 2 },
        { dir: dirB, domain: 'package', priority: 1 },
      ])
    );

    const names = skills.map(s => s.name).sort();
    expect(names).toEqual(['skill-a', 'skill-b']);
  });

  it('deduplicates skills: higher priority wins over lower priority', async () => {
    const highDir = await makeTempDir();
    const lowDir = await makeTempDir();

    await createSkill(highDir, 'shared', 'High priority content');
    await createSkill(lowDir, 'shared', 'Low priority content');

    const skills = await listSkills(
      searchPaths([
        { dir: highDir, domain: 'project', priority: 10 },
        { dir: lowDir, domain: 'package', priority: 1 },
      ])
    );

    // Only one entry for 'shared'
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('shared');
    expect(skills[0].domain).toBe('project');
    expect(skills[0].path).toContain(highDir);
  });

  it('keeps unique skills from both high and low priority paths', async () => {
    const highDir = await makeTempDir();
    const lowDir = await makeTempDir();

    await createSkill(highDir, 'shared', 'High priority');
    await createSkill(lowDir, 'shared', 'Low priority');
    await createSkill(lowDir, 'unique', 'Only in low');

    const skills = await listSkills(
      searchPaths([
        { dir: highDir, domain: 'project', priority: 10 },
        { dir: lowDir, domain: 'package', priority: 1 },
      ])
    );

    const names = skills.map(s => s.name).sort();
    expect(names).toEqual(['shared', 'unique']);
  });

  it('skips directories that do not contain SKILL.md', async () => {
    const dir = await makeTempDir();
    await createSkill(dir, 'valid-skill');
    // Directory without SKILL.md
    await fs.mkdir(path.join(dir, 'not-a-skill'), { recursive: true });

    const skills = await listSkills(searchPaths([{ dir, domain: 'project', priority: 1 }]));
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('valid-skill');
  });

  it('handles non-existent search paths gracefully', async () => {
    const dir = await makeTempDir();
    const fakeDir = path.join(dir, 'nope');

    const skills = await listSkills(
      searchPaths([{ dir: fakeDir, domain: 'workspace', priority: 1 }])
    );

    expect(skills).toEqual([]);
  });

  it('handles a mix of non-existent and valid search paths', async () => {
    const dir = await makeTempDir();
    const fakeDir = path.join(dir, 'nope');

    await createSkill(dir, 'real');

    const skills = await listSkills(
      searchPaths([
        { dir: fakeDir, domain: 'workspace', priority: 5 },
        { dir, domain: 'project', priority: 1 },
      ])
    );

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('real');
  });

  it('returns the correct domain for each discovered skill', async () => {
    const projectDir = await makeTempDir();
    const packageDir = await makeTempDir();

    await createSkill(projectDir, 'proj-skill');
    await createSkill(packageDir, 'pkg-skill');

    const skills = await listSkills(
      searchPaths([
        { dir: projectDir, domain: 'project', priority: 3 },
        { dir: packageDir, domain: 'package', priority: 1 },
      ])
    );

    const byName = new Map<string, DiscoveredSkill>(skills.map(s => [s.name, s]));
    expect(byName.get('proj-skill')!.domain).toBe('project');
    expect(byName.get('pkg-skill')!.domain).toBe('package');
  });

  it('handles an empty search path (no skills dir at all)', async () => {
    const dir = await makeTempDir();

    const skills = await listSkills(searchPaths([{ dir, domain: 'project', priority: 1 }]));
    expect(skills).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// skillExists
// ---------------------------------------------------------------------------

describe('skillExists', () => {
  it('returns true when the skill is found', async () => {
    const dir = await makeTempDir();
    await createSkill(dir, 'tester');

    const exists = await skillExists('tester', searchPaths([{ dir, domain: 'project', priority: 1 }]));
    expect(exists).toBe(true);
  });

  it('returns false when the skill is not found', async () => {
    const dir = await makeTempDir();

    const exists = await skillExists('ghost', searchPaths([{ dir, domain: 'project', priority: 1 }]));
    expect(exists).toBe(false);
  });

  it('returns true when the skill exists in a lower-priority path but not the first', async () => {
    const highDir = await makeTempDir();
    const lowDir = await makeTempDir();

    await createSkill(lowDir, 'fallback');

    const exists = await skillExists(
      'fallback',
      searchPaths([
        { dir: highDir, domain: 'project', priority: 10 },
        { dir: lowDir, domain: 'package', priority: 1 },
      ])
    );

    expect(exists).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readSkillContent
// ---------------------------------------------------------------------------

describe('readSkillContent', () => {
  it('returns the file content of a found skill', async () => {
    const dir = await makeTempDir();
    const content = '# My Skill\n\nSome instructions.';
    await createSkill(dir, 'reader', content);

    const result = await readSkillContent('reader', searchPaths([{ dir, domain: 'project', priority: 1 }]));
    expect(result).toBe(content);
  });

  it('returns null when the skill does not exist', async () => {
    const dir = await makeTempDir();

    const result = await readSkillContent('nope', searchPaths([{ dir, domain: 'project', priority: 1 }]));
    expect(result).toBeNull();
  });

  it('reads from the highest-priority match when the skill exists in multiple paths', async () => {
    const highDir = await makeTempDir();
    const lowDir = await makeTempDir();

    await createSkill(highDir, 'dual', 'HIGH');
    await createSkill(lowDir, 'dual', 'LOW');

    const result = await readSkillContent(
      'dual',
      searchPaths([
        { dir: highDir, domain: 'project', priority: 10 },
        { dir: lowDir, domain: 'package', priority: 1 },
      ])
    );

    expect(result).toBe('HIGH');
  });

  it('returns content that includes multi-line markdown', async () => {
    const dir = await makeTempDir();
    const markdown = [
      '# Deployer',
      '',
      '## Description',
      'Deploys the application to production.',
      '',
      '## Steps',
      '1. Build',
      '2. Test',
      '3. Ship it',
    ].join('\n');

    await createSkill(dir, 'deployer', markdown);

    const result = await readSkillContent('deployer', searchPaths([{ dir, domain: 'project', priority: 1 }]));
    expect(result).toBe(markdown);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('handles an empty searchPaths array', async () => {
    const result = await findSkill('anything', []);
    expect(result).toBeNull();
  });

  it('listSkills returns empty for an empty searchPaths array', async () => {
    const skills = await listSkills([]);
    expect(skills).toEqual([]);
  });

  it('findSkill ignores regular files that look like skill directories', async () => {
    const dir = await makeTempDir();
    // Create a regular file named "deployer" (not a directory)
    await fs.writeFile(path.join(dir, 'deployer'), 'not a directory');

    const result = await findSkill('deployer', searchPaths([{ dir, domain: 'project', priority: 1 }]));
    expect(result).toBeNull();
  });

  it('readSkillContent returns null for a skill whose directory exists but SKILL.md was deleted between find and read', async () => {
    // This is a hard-to-trigger race condition; we verify the function returns
    // null rather than throwing when the file disappears.
    const dir = await makeTempDir();
    const skillDir = path.join(dir, 'vanishing');
    await fs.mkdir(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.writeFile(skillFile, 'will be deleted');

    // Delete the file after creation but before reading
    await fs.unlink(skillFile);

    const result = await readSkillContent('vanishing', searchPaths([{ dir, domain: 'project', priority: 1 }]));
    expect(result).toBeNull();
  });
});
