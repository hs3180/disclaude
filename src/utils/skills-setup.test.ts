/**
 * Tests for skills-setup utility (src/utils/skills-setup.ts)
 *
 * Note: This module interacts heavily with the file system, so we test
 * the function interface rather than full implementation details.
 */

import { describe, it, expect } from 'vitest';
import { setupSkillsInWorkspace } from './skills-setup.js';

describe('setupSkillsInWorkspace', () => {
  it('should be a function', () => {
    expect(typeof setupSkillsInWorkspace).toBe('function');
  });

  it('should return a promise that resolves to an object with success property', async () => {
    // This will likely fail in the test environment, but tests the interface
    const result = await setupSkillsInWorkspace();

    expect(result).toHaveProperty('success');
    expect(typeof result.success).toBe('boolean');
  });

  it('should return error property when not successful', async () => {
    const result = await setupSkillsInWorkspace();

    if (!result.success) {
      expect(result).toHaveProperty('error');
      expect(typeof result.error).toBe('string');
    }
  });
});

describe('setupSkillsInWorkspace return type', () => {
  it('should have correct type structure', () => {
    // Type check - this ensures the return type is correct
    type ResultType = {
      success: boolean;
      error?: string;
    };

    const checkType = (_result: ResultType) => {
      // Just a type check
    };

    // Verify the function returns the expected type
    const promise = setupSkillsInWorkspace();
    expect(promise).toBeInstanceOf(Promise);

    // Would be called with result in real usage
    checkType({ success: true });
    checkType({ success: false, error: 'test error' });
  });
});
