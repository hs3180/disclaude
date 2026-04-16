/**
 * Tests for PR Scanner label-manager.
 *
 * Uses dependency injection (ghExec mock) instead of mocking node:child_process,
 * avoiding promisify compatibility issues with vi.mock.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  addLabel,
  removeLabel,
  ensureLabel,
  executeAction,
  parseArgs,
  type GhExecFn,
} from '../label-manager.js';

function createMockExec(responses: Array<{ stdout?: string; error?: string }>): GhExecFn {
  let callCount = 0;
  return vi.fn((_args: string[]) => {
    const idx = Math.min(callCount, responses.length - 1);
    callCount++;
    const response = responses[idx];
    if (response.error) {
      throw new Error(response.error);
    }
    return response.stdout ?? '';
  });
}

describe('label-manager', () => {
  describe('parseArgs', () => {
    it('should parse valid arguments', () => {
      const result = parseArgs(['--action', 'add', '--pr', '123', '--label', 'pr-scanner:reviewing']);
      expect(result).toEqual({ action: 'add', pr: 123, label: 'pr-scanner:reviewing' });
    });

    it('should parse remove action', () => {
      const result = parseArgs(['--action', 'remove', '--pr', '456', '--label', 'test']);
      expect(result).toEqual({ action: 'remove', pr: 456, label: 'test' });
    });

    it('should parse ensure action', () => {
      const result = parseArgs(['--action', 'ensure', '--pr', '789', '--label', 'test']);
      expect(result).toEqual({ action: 'ensure', pr: 789, label: 'test' });
    });

    it('should throw on missing --action', () => {
      expect(() => parseArgs(['--pr', '123', '--label', 'test'])).toThrow();
    });

    it('should throw on missing --pr', () => {
      expect(() => parseArgs(['--action', 'add', '--label', 'test'])).toThrow();
    });

    it('should throw on missing --label', () => {
      expect(() => parseArgs(['--action', 'add', '--pr', '123'])).toThrow();
    });

    it('should throw on invalid action', () => {
      expect(() => parseArgs(['--action', 'invalid', '--pr', '123', '--label', 'test'])).toThrow();
    });

    it('should throw on non-numeric PR number', () => {
      expect(() => parseArgs(['--action', 'add', '--pr', 'abc', '--label', 'test'])).toThrow();
    });

    it('should throw on zero PR number', () => {
      expect(() => parseArgs(['--action', 'add', '--pr', '0', '--label', 'test'])).toThrow();
    });

    it('should throw on negative PR number', () => {
      expect(() => parseArgs(['--action', 'add', '--pr', '-1', '--label', 'test'])).toThrow();
    });
  });

  describe('addLabel', () => {
    it('should return success when gh pr edit succeeds', async () => {
      const mockExec = createMockExec([{ stdout: '' }]);
      const result = await addLabel(123, 'pr-scanner:reviewing', mockExec);

      expect(result).toEqual({
        success: true,
        action: 'add',
        pr: 123,
        label: 'pr-scanner:reviewing',
        error: null,
      });
      expect(mockExec).toHaveBeenCalledWith([
        'pr', 'edit', '123', '--repo', 'hs3180/disclaude', '--add-label', 'pr-scanner:reviewing',
      ]);
    });

    it('should return failure with error message when gh pr edit fails', async () => {
      const mockExec = createMockExec([{ error: 'label not found' }]);
      const result = await addLabel(456, 'nonexistent', mockExec);

      expect(result.success).toBe(false);
      expect(result.action).toBe('add');
      expect(result.pr).toBe(456);
      expect(result.label).toBe('nonexistent');
      expect(result.error).toBe('label not found');
    });

    it('should normalize multiline error messages', async () => {
      const mockExec = createMockExec([{ error: 'line1\nline2\n  line3' }]);
      const result = await addLabel(1, 'test', mockExec);

      expect(result.error).toBe('line1 line2 line3');
    });

    it('should handle error with no message', async () => {
      const mockExec = vi.fn(() => Promise.reject(new Error('')));
      const result = await addLabel(1, 'test', mockExec);

      expect(result.success).toBe(false);
      expect(result.error).toBe('unknown error');
    });
  });

  describe('removeLabel', () => {
    it('should return success when gh pr edit succeeds', async () => {
      const mockExec = createMockExec([{ stdout: '' }]);
      const result = await removeLabel(123, 'pr-scanner:reviewing', mockExec);

      expect(result).toEqual({
        success: true,
        action: 'remove',
        pr: 123,
        label: 'pr-scanner:reviewing',
        error: null,
      });
      expect(mockExec).toHaveBeenCalledWith([
        'pr', 'edit', '123', '--repo', 'hs3180/disclaude', '--remove-label', 'pr-scanner:reviewing',
      ]);
    });

    it('should return failure when gh pr edit fails', async () => {
      const mockExec = createMockExec([{ error: 'not found' }]);
      const result = await removeLabel(789, 'pr-scanner:reviewing', mockExec);

      expect(result.success).toBe(false);
      expect(result.action).toBe('remove');
      expect(result.error).toBe('not found');
    });
  });

  describe('ensureLabel', () => {
    it('should skip add when label already exists', async () => {
      const mockExec = createMockExec([{ stdout: 'pr-scanner:reviewing\nbug\n' }]);
      const result = await ensureLabel(123, 'pr-scanner:reviewing', mockExec);

      expect(result.success).toBe(true);
      expect(result.action).toBe('ensure');
      expect(result.error).toBeNull();
      expect(mockExec).toHaveBeenCalledTimes(1); // Only the check, not the add
    });

    it('should add label when it does not exist', async () => {
      const mockExec = createMockExec([
        { stdout: 'bug\nenhancement\n' }, // check: label not present
        { stdout: '' },                   // add: success
      ]);
      const result = await ensureLabel(123, 'pr-scanner:reviewing', mockExec);

      expect(result.success).toBe(true);
      expect(result.action).toBe('ensure');
      expect(mockExec).toHaveBeenCalledTimes(2); // check + add
    });

    it('should fall back to add when check fails', async () => {
      const mockExec = createMockExec([
        { error: 'API rate limit exceeded' }, // check fails
        { stdout: '' },                       // fallback add succeeds
      ]);
      const result = await ensureLabel(123, 'pr-scanner:reviewing', mockExec);

      expect(result.success).toBe(true);
      expect(mockExec).toHaveBeenCalledTimes(2); // failed check + fallback add
    });

    it('should return failure when both check and fallback add fail', async () => {
      const mockExec = createMockExec([
        { error: 'unauthorized' }, // check fails
        { error: 'unauthorized' }, // add also fails
      ]);
      const result = await ensureLabel(123, 'pr-scanner:reviewing', mockExec);

      expect(result.success).toBe(false);
      expect(result.error).toBe('unauthorized');
    });

    it('should handle empty label list from gh pr view', async () => {
      const mockExec = createMockExec([
        { stdout: '\n' }, // No labels
        { stdout: '' },   // Add succeeds
      ]);
      const result = await ensureLabel(123, 'pr-scanner:reviewing', mockExec);

      expect(result.success).toBe(true);
      expect(mockExec).toHaveBeenCalledTimes(2);
    });

    it('should handle label with similar but different name', async () => {
      const mockExec = createMockExec([
        { stdout: 'pr-scanner:approved\nbug\n' }, // similar but different label
        { stdout: '' },                            // add succeeds
      ]);
      const result = await ensureLabel(123, 'pr-scanner:reviewing', mockExec);

      expect(result.success).toBe(true);
      expect(mockExec).toHaveBeenCalledTimes(2); // check + add (not found)
    });
  });

  describe('executeAction', () => {
    it('should delegate to addLabel for action "add"', async () => {
      const mockExec = createMockExec([{ stdout: '' }]);
      const result = await executeAction('add', 1, 'test', mockExec);

      expect(result.action).toBe('add');
      expect(result.success).toBe(true);
    });

    it('should delegate to removeLabel for action "remove"', async () => {
      const mockExec = createMockExec([{ stdout: '' }]);
      const result = await executeAction('remove', 1, 'test', mockExec);

      expect(result.action).toBe('remove');
      expect(result.success).toBe(true);
    });

    it('should delegate to ensureLabel for action "ensure"', async () => {
      const mockExec = createMockExec([{ stdout: 'test\n' }]);
      const result = await executeAction('ensure', 1, 'test', mockExec);

      expect(result.action).toBe('ensure');
      expect(result.success).toBe(true);
    });
  });
});
