/**
 * Tests for skills-setup utility (packages/core/src/utils/skills-setup.ts)
 *
 * Issue #1617 Phase 2: Tests for skill directory copying logic.
 * Uses real temp directories to avoid fs mocking issues.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock Config module to use temp directories
let mockWorkspaceDir: string;
let mockSkillsDir: string;

vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => mockWorkspaceDir,
    getSkillsDir: () => mockSkillsDir,
  },
}));

// Mock logger
vi.mock('./logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { setupSkillsInWorkspace } from './skills-setup.js';

describe('setupSkillsInWorkspace', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-setup-test-'));
    mockWorkspaceDir = path.join(tempDir, 'workspace');
    mockSkillsDir = path.join(tempDir, 'source-skills');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should return success: false when source directory does not exist', async () => {
    const result = await setupSkillsInWorkspace();

    expect(result.success).toBe(false);
    expect(result.error).toContain('Source skills directory does not exist');
  });

  it('should create target directory and copy all skill directories', async () => {
    // Create source skills
    await fs.mkdir(path.join(mockSkillsDir, 'skill-a'), { recursive: true });
    await fs.writeFile(path.join(mockSkillsDir, 'skill-a', 'index.md'), '# Skill A');
    await fs.mkdir(path.join(mockSkillsDir, 'skill-b'), { recursive: true });
    await fs.writeFile(path.join(mockSkillsDir, 'skill-b', 'main.ts'), 'export default {}');
    // Non-directory file should be skipped
    await fs.writeFile(path.join(mockSkillsDir, 'README.md'), '# Skills');

    const result = await setupSkillsInWorkspace();

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    // Verify target directories created
    const statA = await fs.stat(path.join(mockWorkspaceDir, '.claude', 'skills', 'skill-a', 'index.md'));
    expect(statA.isFile()).toBe(true);
    const statB = await fs.stat(path.join(mockWorkspaceDir, '.claude', 'skills', 'skill-b', 'main.ts'));
    expect(statB.isFile()).toBe(true);
    // README.md should not be copied
    const readmeExists = await fs.stat(path.join(mockWorkspaceDir, '.claude', 'skills', 'README.md'))
      .then(() => true).catch(() => false);
    expect(readmeExists).toBe(false);
  });

  it('should skip non-directory entries in source', async () => {
    await fs.mkdir(mockSkillsDir, { recursive: true });
    await fs.writeFile(path.join(mockSkillsDir, 'file.txt'), 'content');

    const result = await setupSkillsInWorkspace();

    expect(result.success).toBe(true);
    // Target directory should exist but be empty (no skills copied)
    const entries = await fs.readdir(path.join(mockWorkspaceDir, '.claude', 'skills'));
    expect(entries).toEqual([]);
  });

  it('should continue copying other skills when one fails', async () => {
    await fs.mkdir(path.join(mockSkillsDir, 'good-skill'), { recursive: true });
    await fs.writeFile(path.join(mockSkillsDir, 'good-skill', 'index.md'), '# Good');
    await fs.mkdir(path.join(mockSkillsDir, 'failing-skill'), { recursive: true });
    await fs.writeFile(path.join(mockSkillsDir, 'failing-skill', 'index.md'), '# Failing');
    await fs.mkdir(path.join(mockSkillsDir, 'another-good'), { recursive: true });
    await fs.writeFile(path.join(mockSkillsDir, 'another-good', 'index.md'), '# Another');

    // Make failing-skill unreadable by removing read permissions
    await fs.chmod(path.join(mockSkillsDir, 'failing-skill'), 0o000);

    const result = await setupSkillsInWorkspace();

    expect(result.success).toBe(true);

    // Good skills should be copied
    const goodStat = await fs.stat(path.join(mockWorkspaceDir, '.claude', 'skills', 'good-skill', 'index.md'));
    expect(goodStat.isFile()).toBe(true);
    const anotherStat = await fs.stat(path.join(mockWorkspaceDir, '.claude', 'skills', 'another-good', 'index.md'));
    expect(anotherStat.isFile()).toBe(true);

    // Restore permissions for cleanup
    await fs.chmod(path.join(mockSkillsDir, 'failing-skill'), 0o755);
  });

  it('should handle empty source directory', async () => {
    await fs.mkdir(mockSkillsDir, { recursive: true });

    const result = await setupSkillsInWorkspace();

    expect(result.success).toBe(true);
    const entries = await fs.readdir(path.join(mockWorkspaceDir, '.claude', 'skills'));
    expect(entries).toEqual([]);
  });

  it('should copy nested directory structures recursively', async () => {
    // Create nested structure
    const skillDir = path.join(mockSkillsDir, 'nested-skill');
    await fs.mkdir(path.join(skillDir, 'lib', 'utils'), { recursive: true });
    await fs.writeFile(path.join(skillDir, 'index.ts'), 'export {}');
    await fs.writeFile(path.join(skillDir, 'lib', 'helper.ts'), 'export const helper = 1');
    await fs.writeFile(path.join(skillDir, 'lib', 'utils', 'format.ts'), 'export const format = (s: string) => s');

    const result = await setupSkillsInWorkspace();

    expect(result.success).toBe(true);

    // Verify nested files were copied
    const indexPath = path.join(mockWorkspaceDir, '.claude', 'skills', 'nested-skill', 'index.ts');
    const helperPath = path.join(mockWorkspaceDir, '.claude', 'skills', 'nested-skill', 'lib', 'helper.ts');
    const formatPath = path.join(mockWorkspaceDir, '.claude', 'skills', 'nested-skill', 'lib', 'utils', 'format.ts');

    await fs.access(indexPath);
    await fs.access(helperPath);
    await fs.access(formatPath);
  });

  it('should copy file contents correctly', async () => {
    await fs.mkdir(path.join(mockSkillsDir, 'my-skill'), { recursive: true });
    const content = '# My Skill\n\nThis is the skill content.';
    await fs.writeFile(path.join(mockSkillsDir, 'my-skill', 'skill.md'), content);

    const result = await setupSkillsInWorkspace();

    expect(result.success).toBe(true);

    const copiedContent = await fs.readFile(
      path.join(mockWorkspaceDir, '.claude', 'skills', 'my-skill', 'skill.md'),
      'utf-8',
    );
    expect(copiedContent).toBe(content);
  });

  it('should handle target directory already existing', async () => {
    await fs.mkdir(path.join(mockSkillsDir, 'skill-a'), { recursive: true });
    await fs.writeFile(path.join(mockSkillsDir, 'skill-a', 'index.md'), '# Skill A');

    // Pre-create target directory
    await fs.mkdir(path.join(mockWorkspaceDir, '.claude', 'skills'), { recursive: true });

    const result = await setupSkillsInWorkspace();

    expect(result.success).toBe(true);
    const stat = await fs.stat(path.join(mockWorkspaceDir, '.claude', 'skills', 'skill-a', 'index.md'));
    expect(stat.isFile()).toBe(true);
  });

  it('should overwrite existing skill files in target', async () => {
    await fs.mkdir(path.join(mockSkillsDir, 'skill-a'), { recursive: true });
    await fs.writeFile(path.join(mockSkillsDir, 'skill-a', 'index.md'), '# Updated Content');

    // Pre-create with old content
    const targetSkillDir = path.join(mockWorkspaceDir, '.claude', 'skills', 'skill-a');
    await fs.mkdir(targetSkillDir, { recursive: true });
    await fs.writeFile(path.join(targetSkillDir, 'index.md'), '# Old Content');

    const result = await setupSkillsInWorkspace();

    expect(result.success).toBe(true);
    const copiedContent = await fs.readFile(path.join(targetSkillDir, 'index.md'), 'utf-8');
    expect(copiedContent).toBe('# Updated Content');
  });
});
