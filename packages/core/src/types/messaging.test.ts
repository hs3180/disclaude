/**
 * Tests for message level types and routing utilities.
 *
 * Verifies mapAgentMessageTypeToLevel mapping logic,
 * MessageLevel enum values, and constant arrays.
 *
 * Issue #1617: Phase 2 — core types/messaging test coverage.
 */

import { describe, it, expect } from 'vitest';
import {
  MessageLevel,
  DEFAULT_USER_LEVELS,
  ALL_LEVELS,
  mapAgentMessageTypeToLevel,
} from './messaging.js';
import type { ExtendedAgentMessageType } from './agent.js';

describe('MessageLevel enum', () => {
  it('should have all expected values', () => {
    expect(MessageLevel.DEBUG).toBe('debug');
    expect(MessageLevel.PROGRESS).toBe('progress');
    expect(MessageLevel.INFO).toBe('info');
    expect(MessageLevel.NOTICE).toBe('notice');
    expect(MessageLevel.IMPORTANT).toBe('important');
    expect(MessageLevel.ERROR).toBe('error');
    expect(MessageLevel.RESULT).toBe('result');
  });

  it('should have exactly 7 levels', () => {
    const values = Object.values(MessageLevel);
    expect(values).toHaveLength(7);
  });
});

describe('DEFAULT_USER_LEVELS', () => {
  it('should include notice, important, error, and result', () => {
    expect(DEFAULT_USER_LEVELS).toEqual([
      MessageLevel.NOTICE,
      MessageLevel.IMPORTANT,
      MessageLevel.ERROR,
      MessageLevel.RESULT,
    ]);
  });

  it('should not include debug, progress, or info', () => {
    expect(DEFAULT_USER_LEVELS).not.toContain(MessageLevel.DEBUG);
    expect(DEFAULT_USER_LEVELS).not.toContain(MessageLevel.PROGRESS);
    expect(DEFAULT_USER_LEVELS).not.toContain(MessageLevel.INFO);
  });
});

describe('ALL_LEVELS', () => {
  it('should include all 7 levels in ascending order', () => {
    expect(ALL_LEVELS).toEqual([
      MessageLevel.DEBUG,
      MessageLevel.PROGRESS,
      MessageLevel.INFO,
      MessageLevel.NOTICE,
      MessageLevel.IMPORTANT,
      MessageLevel.ERROR,
      MessageLevel.RESULT,
    ]);
  });

  it('should be a superset of DEFAULT_USER_LEVELS', () => {
    for (const level of DEFAULT_USER_LEVELS) {
      expect(ALL_LEVELS).toContain(level);
    }
  });
});

describe('mapAgentMessageTypeToLevel', () => {
  it('should map tool_progress to PROGRESS', () => {
    expect(mapAgentMessageTypeToLevel('tool_progress')).toBe(MessageLevel.PROGRESS);
  });

  it('should map tool_use to DEBUG', () => {
    expect(mapAgentMessageTypeToLevel('tool_use')).toBe(MessageLevel.DEBUG);
  });

  it('should map tool_result to DEBUG', () => {
    expect(mapAgentMessageTypeToLevel('tool_result')).toBe(MessageLevel.DEBUG);
  });

  it('should map error to ERROR', () => {
    expect(mapAgentMessageTypeToLevel('error')).toBe(MessageLevel.ERROR);
  });

  it('should map notification to NOTICE', () => {
    expect(mapAgentMessageTypeToLevel('notification')).toBe(MessageLevel.NOTICE);
  });

  it('should map task_completion to RESULT', () => {
    expect(mapAgentMessageTypeToLevel('task_completion')).toBe(MessageLevel.RESULT);
  });

  it('should map max_iterations_warning to IMPORTANT', () => {
    expect(mapAgentMessageTypeToLevel('max_iterations_warning')).toBe(MessageLevel.IMPORTANT);
  });

  it('should map status to INFO', () => {
    expect(mapAgentMessageTypeToLevel('status')).toBe(MessageLevel.INFO);
  });

  it('should map text to INFO', () => {
    expect(mapAgentMessageTypeToLevel('text')).toBe(MessageLevel.INFO);
  });

  describe('result type with content-aware mapping', () => {
    it('should map result without content to RESULT level', () => {
      expect(mapAgentMessageTypeToLevel('result')).toBe(MessageLevel.RESULT);
    });

    it('should map result with non-completion content to RESULT level', () => {
      expect(mapAgentMessageTypeToLevel('result', 'Here is the answer')).toBe(MessageLevel.RESULT);
    });

    it('should map result with completion message to DEBUG level', () => {
      expect(mapAgentMessageTypeToLevel('result', '✅ Complete')).toBe(MessageLevel.DEBUG);
    });

    it('should map result with completion prefix to DEBUG level', () => {
      expect(mapAgentMessageTypeToLevel('result', '✅ Completed all tasks')).toBe(MessageLevel.DEBUG);
    });

    it('should map result with empty string content to RESULT level', () => {
      expect(mapAgentMessageTypeToLevel('result', '')).toBe(MessageLevel.RESULT);
    });

    it('should map result with partial match (not starts with) to RESULT level', () => {
      expect(mapAgentMessageTypeToLevel('result', 'The result is ✅ Complete')).toBe(MessageLevel.RESULT);
    });
  });

  it('should map unknown types to INFO (default case)', () => {
    // The function has a default case that falls through to INFO
    // Casting to test the default branch with an unlikely value
    expect(mapAgentMessageTypeToLevel('unknown_type' as ExtendedAgentMessageType)).toBe(MessageLevel.INFO);
  });
});
