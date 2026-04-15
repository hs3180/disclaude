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
    getWorkspaceDir: (...args: unknown[]) => mockGetWorkspaceDir(...args),
    getAgentsDir: (...args: unknown[]) => mockGetAgentsDir(...args),
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
    ({ setupAgentsInWorkspace } = mod);
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
      await fs.writeFile(path.join(sourceDir, 'test-agent.md'), '# Test Agent');
      await fs.writeFile(path.join(sourceDir, 'custom-agent.md'), '# Custom Agent');
      await fs.writeFile(path.join(sourceDir, 'README.txt'), 'Not an agent');

      const result = await setupAgentsInWorkspace();

      expect(result.success).toBe(true);

      // Verify .md files were copied
      const testAgentContent = await fs.readFile(
        path.join(targetDir, 'test-agent.md'), 'utf-8',
      );
      expect(testAgentContent).toBe('# Test Agent');

      const customAgentContent = await fs.readFile(
        path.join(targetDir, 'custom-agent.md'), 'utf-8',
      );
      expect(customAgentContent).toBe('# Custom Agent');

      // Verify non-.md files were NOT copied
      await expect(
        fs.access(path.join(targetDir, 'README.txt')),
      ).rejects.toThrow();
    });

    it('should not overwrite existing agent definitions', async () => {
      // Create source agents
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, 'test-agent.md'), '# New Content');

      // Create existing target agent
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(path.join(targetDir, 'test-agent.md'), '# Existing Content');

      const result = await setupAgentsInWorkspace();

      expect(result.success).toBe(true);

      // Verify existing file was NOT overwritten
      const content = await fs.readFile(
        path.join(targetDir, 'test-agent.md'), 'utf-8',
      );
      expect(content).toBe('# Existing Content');
    });

    it('should succeed with empty agents directory', async () => {
      await fs.mkdir(sourceDir, { recursive: true });

      const result = await setupAgentsInWorkspace();

      expect(result.success).toBe(true);

      // Verify target directory was created
      const stat = await fs.stat(targetDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });
});
