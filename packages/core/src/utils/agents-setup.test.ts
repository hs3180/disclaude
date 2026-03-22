/**
 * Tests for agents-setup utility (Issue #1410)
 *
 * Tests the setupAgentsInWorkspace function which copies preset agent
 * definitions from the package directory to the workspace's .claude/agents/.
 *
 * Uses real temp directories for integration testing to avoid ESM spying issues.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// We need to mock Config before importing agents-setup
const mockGetWorkspaceDir = vi.fn();
const mockGetAgentsDir = vi.fn();

vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: (...args: any[]) => mockGetWorkspaceDir(...args),
    getAgentsDir: (...args: any[]) => mockGetAgentsDir(...args),
  },
}));

describe('setupAgentsInWorkspace', () => {
  let setupAgentsInWorkspace: typeof import('./agents-setup.js').setupAgentsInWorkspace;
  let tempDir: string;
  let sourceDir: string;
  let targetDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agents-setup-test-'));
    sourceDir = path.join(tempDir, 'package-agents');
    targetDir = path.join(tempDir, 'workspace', '.claude', 'agents');

    mockGetWorkspaceDir.mockReturnValue(path.join(tempDir, 'workspace'));
    mockGetAgentsDir.mockReturnValue(sourceDir);

    // Re-import the module after mocks are set up
    vi.resetModules();
    const mod = await import('./agents-setup.js');
    setupAgentsInWorkspace = mod.setupAgentsInWorkspace;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await vi.resetModules();
    // Cleanup temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('when source agents directory does not exist', () => {
    it('should return success without error (agents dir is optional)', async () => {
      mockGetAgentsDir.mockReturnValue('/nonexistent/agents');

      const result = await setupAgentsInWorkspace();

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe('when copying agent definitions', () => {
    it('should create .claude/agents/ directory and copy .md files', async () => {
      // Create source agents
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, 'schedule-executor.md'), '# Schedule Executor');
      await fs.writeFile(path.join(sourceDir, 'skill-runner.md'), '# Skill Runner');
      await fs.writeFile(path.join(sourceDir, 'task-agent.md'), '# Task Agent');
      await fs.writeFile(path.join(sourceDir, 'README.txt'), 'Not an agent');

      const result = await setupAgentsInWorkspace();

      expect(result.success).toBe(true);

      // Verify .md files were copied
      const scheduleContent = await fs.readFile(
        path.join(targetDir, 'schedule-executor.md'), 'utf-8'
      );
      expect(scheduleContent).toBe('# Schedule Executor');

      const skillContent = await fs.readFile(
        path.join(targetDir, 'skill-runner.md'), 'utf-8'
      );
      expect(skillContent).toBe('# Skill Runner');

      // Verify non-.md files were NOT copied
      await expect(
        fs.readFile(path.join(targetDir, 'README.txt'), 'utf-8')
      ).rejects.toThrow();
    });

    it('should skip .md files that already exist in target (preserve user customizations)', async () => {
      // Create source agents
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, 'schedule-executor.md'), '# New Version');
      await fs.writeFile(path.join(sourceDir, 'skill-runner.md'), '# Skill Runner');

      // Pre-existing file in target with different content
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(path.join(targetDir, 'schedule-executor.md'), '# Custom Version');

      const result = await setupAgentsInWorkspace();

      expect(result.success).toBe(true);

      // Verify pre-existing file was NOT overwritten
      const scheduleContent = await fs.readFile(
        path.join(targetDir, 'schedule-executor.md'), 'utf-8'
      );
      expect(scheduleContent).toBe('# Custom Version');

      // Verify new file was copied
      const skillContent = await fs.readFile(
        path.join(targetDir, 'skill-runner.md'), 'utf-8'
      );
      expect(skillContent).toBe('# Skill Runner');
    });

    it('should ignore directories in source', async () => {
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.mkdir(path.join(sourceDir, 'some-directory'));
      await fs.writeFile(path.join(sourceDir, 'agent.md'), '# Agent');

      const result = await setupAgentsInWorkspace();

      expect(result.success).toBe(true);
      const files = await fs.readdir(targetDir);
      expect(files).toEqual(['agent.md']);
    });

    it('should ignore non-.md files', async () => {
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, 'agent.md'), '# Agent');
      await fs.writeFile(path.join(sourceDir, 'config.json'), '{}');
      await fs.writeFile(path.join(sourceDir, 'data.yaml'), 'key: value');

      const result = await setupAgentsInWorkspace();

      expect(result.success).toBe(true);
      const files = await fs.readdir(targetDir);
      expect(files).toEqual(['agent.md']);
    });

    it('should handle empty agents directory gracefully', async () => {
      await fs.mkdir(sourceDir, { recursive: true });

      const result = await setupAgentsInWorkspace();

      expect(result.success).toBe(true);
      // Target directory should still be created
      const stat = await fs.stat(targetDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should succeed even if source directory has only non-.md files', async () => {
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, 'config.json'), '{}');
      await fs.writeFile(path.join(sourceDir, 'README.txt'), 'readme');

      const result = await setupAgentsInWorkspace();

      expect(result.success).toBe(true);
      const files = await fs.readdir(targetDir);
      expect(files).toEqual([]);
    });
  });
});
