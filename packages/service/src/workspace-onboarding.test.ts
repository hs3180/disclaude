import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { workspaceSelection, validateWorkspaceSelection } from './workspace-onboarding.js';

describe('first-run workspace paths', () => {
  it('suggests a visible home child and expands custom home/relative paths', () => {
    expect(workspaceSelection('', '/home/test')).toBe('/home/test/disclaude-workspace');
    expect(workspaceSelection('~/My tasks', '/home/test')).toBe('/home/test/My tasks');
    expect(workspaceSelection('tasks')).toBe(resolve('tasks'));
    expect(() => workspaceSelection('bad\0path')).toThrow('invalid characters');
  });
  it('rejects files and file ancestors without creating an unconfirmed workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-path-'));
    try {
      await writeFile(join(root, 'file'), 'preserve');
      await expect(validateWorkspaceSelection(join(root, 'file'))).rejects.toThrow('Not a directory');
      await expect(validateWorkspaceSelection(join(root, 'file', 'child'))).rejects.toThrow();
      await expect(validateWorkspaceSelection(join(root, 'future', 'tasks'))).resolves.toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
