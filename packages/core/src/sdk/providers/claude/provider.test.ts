/**
 * Tests for Claude SDK Provider stderr capture utilities.
 *
 * Issue #2920: Tests for StderrCapture, getErrorStderr, isStartupFailure.
 */

import { describe, it, expect } from 'vitest';
import { StderrCapture, getErrorStderr, isStartupFailure, attachStderrToError } from './provider.js';

// ============================================================================
// StderrCapture
// ============================================================================

describe('StderrCapture', () => {
  it('should buffer appended lines', () => {
    const capture = new StderrCapture();
    capture.append('line 1');
    capture.append('line 2');
    capture.append('line 3');

    expect(capture.hasContent()).toBe(true);
    expect(capture.getCaptured()).toBe('line 1\nline 2\nline 3');
  });

  it('should ignore empty lines', () => {
    const capture = new StderrCapture();
    capture.append('');
    capture.append('   ');
    capture.append('\n');

    expect(capture.hasContent()).toBe(false);
    expect(capture.getCaptured()).toBe('');
  });

  it('should trim trailing whitespace from lines', () => {
    const capture = new StderrCapture();
    capture.append('hello  \n');
    capture.append('world\n');

    expect(capture.getCaptured()).toBe('hello\nworld');
  });

  it('should respect maxLines limit', () => {
    const capture = new StderrCapture(3);
    capture.append('line 1');
    capture.append('line 2');
    capture.append('line 3');
    capture.append('line 4');
    capture.append('line 5');

    // Should only keep last 3 lines
    expect(capture.getCaptured()).toBe('line 3\nline 4\nline 5');
  });

  it('should return empty when no content', () => {
    const capture = new StderrCapture();
    expect(capture.hasContent()).toBe(false);
    expect(capture.getCaptured()).toBe('');
    expect(capture.getTail()).toBe('');
  });

  describe('getTail', () => {
    it('should return full text when within maxChars', () => {
      const capture = new StderrCapture();
      capture.append('short text');

      expect(capture.getTail(100)).toBe('short text');
    });

    it('should truncate with ellipsis when exceeding maxChars', () => {
      const capture = new StderrCapture();
      const longText = 'a'.repeat(600);
      capture.append(longText);

      const result = capture.getTail(100);
      expect(result.length).toBeLessThanOrEqual(100);
      expect(result.startsWith('...')).toBe(true);
      expect(result).toContain('aaa');
    });
  });

  describe('reset', () => {
    it('should clear all buffered content', () => {
      const capture = new StderrCapture();
      capture.append('line 1');
      capture.append('line 2');

      capture.reset();

      expect(capture.hasContent()).toBe(false);
      expect(capture.getCaptured()).toBe('');
    });
  });
});

// ============================================================================
// attachStderrToError / getErrorStderr
// ============================================================================

describe('attachStderrToError / getErrorStderr', () => {
  it('should attach and retrieve stderr from Error object', () => {
    const error = new Error('test error');
    attachStderrToError(error, 'MCP server failed to initialize');

    const stderr = getErrorStderr(error);
    expect(stderr).toBe('MCP server failed to initialize');
  });

  it('should return undefined for Error without attached stderr', () => {
    const error = new Error('test error');
    expect(getErrorStderr(error)).toBeUndefined();
  });

  it('should return undefined for non-Error values', () => {
    expect(getErrorStderr('string error')).toBeUndefined();
    expect(getErrorStderr(42)).toBeUndefined();
    expect(getErrorStderr(null)).toBeUndefined();
    expect(getErrorStderr(undefined)).toBeUndefined();
  });

  it('should handle stderr with multiline content', () => {
    const error = new Error('CLI exited');
    const multilineStderr = [
      'Error: MCP server "amap-maps" failed to initialize',
      '  at initializeMcpServer (sdk.js:123:45)',
      '  at startProcess (sdk.js:67:89)',
      'Caused by: command is empty or undefined',
    ].join('\n');
    attachStderrToError(error, multilineStderr);

    expect(getErrorStderr(error)).toBe(multilineStderr);
  });
});

// ============================================================================
// isStartupFailure
// ============================================================================

describe('isStartupFailure', () => {
  it('should detect startup failure: 0 messages, short elapsed time', () => {
    expect(isStartupFailure(0, 500)).toBe(true);
    expect(isStartupFailure(0, 1000)).toBe(true);
    expect(isStartupFailure(0, 5000)).toBe(true);
    expect(isStartupFailure(0, 9999)).toBe(true);
  });

  it('should not detect startup failure: messages received', () => {
    expect(isStartupFailure(1, 500)).toBe(false);
    expect(isStartupFailure(5, 1000)).toBe(false);
    expect(isStartupFailure(1, 9999)).toBe(false);
  });

  it('should not detect startup failure: elapsed time exceeds threshold', () => {
    expect(isStartupFailure(0, 10_000)).toBe(false);
    expect(isStartupFailure(0, 15_000)).toBe(false);
    expect(isStartupFailure(0, 60_000)).toBe(false);
  });

  it('should detect startup failure at boundary', () => {
    // Just under threshold
    expect(isStartupFailure(0, 9999)).toBe(true);
    // At threshold
    expect(isStartupFailure(0, 10_000)).toBe(false);
  });
});
