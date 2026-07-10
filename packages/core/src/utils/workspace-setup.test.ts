/**
 * Tests for workspace-setup utility (Issue #4254)
 *
 * Tests ensureWorkspaceDir, which creates the configured workspace directory
 * (recursive, idempotent) so the legacy workspace/.gitkeep placeholder is no
 * longer needed.
 *
 * Uses real temp directories, following the pattern in skills-setup.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock Config before importing workspace-setup
const mockGetWorkspaceDir = vi.fn();

vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: (...args: unknown[]) => mockGetWorkspaceDir(...args),
  },
}));

describe('ensureWorkspaceDir', () => {
  let ensureWorkspaceDir: typeof import('./workspace-setup.js').ensureWorkspaceDir;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-setup-test-'));
    vi.resetModules();
    const mod = await import('./workspace-setup.js');
    ({ ensureWorkspaceDir } = mod);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await vi.resetModules();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should create the workspace directory when it does not exist', async () => {
    const workspaceDir = path.join(tempDir, 'workspace');
    mockGetWorkspaceDir.mockReturnValue(workspaceDir);

    // Precondition: directory does not exist
    await expect(fs.access(workspaceDir)).rejects.toThrow();

    const result = await ensureWorkspaceDir();

    expect(result).toBe(workspaceDir);
    const stat = await fs.stat(workspaceDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('should be idempotent when the directory already exists', async () => {
    const workspaceDir = path.join(tempDir, 'workspace');
    await fs.mkdir(workspaceDir, { recursive: true });
    mockGetWorkspaceDir.mockReturnValue(workspaceDir);

    const result = await ensureWorkspaceDir();

    expect(result).toBe(workspaceDir);
    const stat = await fs.stat(workspaceDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('should create nested parent directories', async () => {
    const workspaceDir = path.join(tempDir, 'a', 'b', 'c', 'workspace');
    mockGetWorkspaceDir.mockReturnValue(workspaceDir);

    const result = await ensureWorkspaceDir();

    expect(result).toBe(workspaceDir);
    const stat = await fs.stat(workspaceDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('should resolve the path via Config.getWorkspaceDir()', async () => {
    const workspaceDir = path.join(tempDir, 'from-config');
    mockGetWorkspaceDir.mockReturnValue(workspaceDir);

    await ensureWorkspaceDir();

    expect(mockGetWorkspaceDir).toHaveBeenCalled();
    const stat = await fs.stat(workspaceDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('should not throw when mkdir fails (logs warning instead)', async () => {
    // Point at a path whose parent is a file → mkdir will reject with ENOTDIR
    const blockingFile = path.join(tempDir, 'blocking-file');
    await fs.writeFile(blockingFile, '');
    const workspaceDir = path.join(blockingFile, 'workspace');
    mockGetWorkspaceDir.mockReturnValue(workspaceDir);

    // Should resolve, not reject
    const result = await ensureWorkspaceDir();
    expect(result).toBe(workspaceDir);
  });
});
