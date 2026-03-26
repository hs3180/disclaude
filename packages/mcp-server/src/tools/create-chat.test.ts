/**
 * Tests for create_chat tool - soul parameter support.
 *
 * Issue #1228: Discussion focus via SOUL.md personality injection.
 */

import path from 'path';
import os from 'os';
import { describe, it, expect } from 'vitest';
import { resolveSoulPath } from './create-chat.js';

describe('resolveSoulPath', () => {
  it('should resolve "discussion" to the built-in profile path', () => {
    const result = resolveSoulPath('discussion');
    expect(result).toContain('souls');
    expect(result).toContain('discussion.md');
    expect(path.isAbsolute(result)).toBe(true);
  });

  it('should resolve absolute paths as-is', () => {
    const absolutePath = '/etc/souls/my-soul.md';
    expect(resolveSoulPath(absolutePath)).toBe(absolutePath);
  });

  it('should expand tilde paths to home directory', () => {
    const result = resolveSoulPath('~/.disclaude/souls/custom.md');
    expect(result).toBe(path.join(os.homedir(), '.disclaude/souls/custom.md'));
  });

  it('should resolve relative paths against workspace when provided', () => {
    const result = resolveSoulPath('souls/custom.md', '/project/workspace');
    expect(result).toBe(path.resolve('/project/workspace', 'souls/custom.md'));
  });

  it('should resolve relative paths against cwd when no workspace', () => {
    const result = resolveSoulPath('souls/custom.md');
    expect(result).toBe(path.resolve('souls/custom.md'));
  });

  it('should handle various built-in profile names', () => {
    // "discussion" is the only built-in currently, but the resolution should work
    const result = resolveSoulPath('discussion');
    expect(result).toContain('discussion.md');
  });
});
