/**
 * Tests for messaging types (packages/core/src/types/messaging.ts)
 *
 * Issue #1617 Phase 2: Tests for messaging enums, constants, and mapping functions.
 *
 * Covers:
 * - MessageLevel enum values
 * - DEFAULT_USER_LEVELS and ALL_LEVELS constants
 * - mapAgentMessageTypeToLevel: mapping logic for all message types
 * - Edge cases: default/fallback behavior, content-based routing
 */

import { describe, it, expect } from 'vitest';
import {
  MessageLevel,
  DEFAULT_USER_LEVELS,
  ALL_LEVELS,
  mapAgentMessageTypeToLevel,
} from './messaging.js';

describe('Messaging Types', () => {
  // =========================================================================
  // MessageLevel enum
  // =========================================================================
  describe('MessageLevel', () => {
    it('should have correct string values for all levels', () => {
      expect(MessageLevel.DEBUG).toBe('debug');
      expect(MessageLevel.PROGRESS).toBe('progress');
      expect(MessageLevel.INFO).toBe('info');
      expect(MessageLevel.NOTICE).toBe('notice');
      expect(MessageLevel.IMPORTANT).toBe('important');
      expect(MessageLevel.ERROR).toBe('error');
      expect(MessageLevel.RESULT).toBe('result');
    });

    it('should have exactly 7 levels', () => {
      const levels = Object.values(MessageLevel);
      expect(levels).toHaveLength(7);
    });

    it('should have unique values', () => {
      const levels = Object.values(MessageLevel);
      const unique = new Set(levels);
      expect(unique.size).toBe(levels.length);
    });
  });

  // =========================================================================
  // DEFAULT_USER_LEVELS
  // =========================================================================
  describe('DEFAULT_USER_LEVELS', () => {
    it('should contain NOTICE, IMPORTANT, ERROR, RESULT', () => {
      expect(DEFAULT_USER_LEVELS).toContain(MessageLevel.NOTICE);
      expect(DEFAULT_USER_LEVELS).toContain(MessageLevel.IMPORTANT);
      expect(DEFAULT_USER_LEVELS).toContain(MessageLevel.ERROR);
      expect(DEFAULT_USER_LEVELS).toContain(MessageLevel.RESULT);
    });

    it('should have 4 levels', () => {
      expect(DEFAULT_USER_LEVELS).toHaveLength(4);
    });

    it('should NOT contain admin-only levels', () => {
      expect(DEFAULT_USER_LEVELS).not.toContain(MessageLevel.DEBUG);
      expect(DEFAULT_USER_LEVELS).not.toContain(MessageLevel.PROGRESS);
      expect(DEFAULT_USER_LEVELS).not.toContain(MessageLevel.INFO);
    });
  });

  // =========================================================================
  // ALL_LEVELS
  // =========================================================================
  describe('ALL_LEVELS', () => {
    it('should contain all MessageLevel values', () => {
      Object.values(MessageLevel).forEach((level) => {
        expect(ALL_LEVELS).toContain(level);
      });
    });

    it('should have 7 levels', () => {
      expect(ALL_LEVELS).toHaveLength(7);
    });

    it('should be a superset of DEFAULT_USER_LEVELS', () => {
      DEFAULT_USER_LEVELS.forEach((level) => {
        expect(ALL_LEVELS).toContain(level);
      });
    });
  });

  // =========================================================================
  // mapAgentMessageTypeToLevel
  // =========================================================================
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

    it('should map result to RESULT by default', () => {
      expect(mapAgentMessageTypeToLevel('result')).toBe(MessageLevel.RESULT);
    });

    it('should map result with "✅ Complete" content to DEBUG', () => {
      expect(mapAgentMessageTypeToLevel('result', '✅ Complete: task finished')).toBe(MessageLevel.DEBUG);
    });

    it('should map result without completion prefix to RESULT', () => {
      expect(mapAgentMessageTypeToLevel('result', 'Here is the output')).toBe(MessageLevel.RESULT);
    });

    it('should map result with empty content to RESULT', () => {
      expect(mapAgentMessageTypeToLevel('result', '')).toBe(MessageLevel.RESULT);
    });

    it('should map result with undefined content to RESULT', () => {
      expect(mapAgentMessageTypeToLevel('result')).toBe(MessageLevel.RESULT);
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

    it('should map unknown type to INFO (default fallback)', () => {
      // Testing default case with a cast
      expect(mapAgentMessageTypeToLevel('unknown_type' as any)).toBe(MessageLevel.INFO);
    });

    it('should match "✅ Complete" prefix for result DEBUG mapping', () => {
      // "✅ Complete" prefix maps to DEBUG
      expect(mapAgentMessageTypeToLevel('result', '✅ Complete')).toBe(MessageLevel.DEBUG);
      expect(mapAgentMessageTypeToLevel('result', '✅ Complete: task finished')).toBe(MessageLevel.DEBUG);
      // "✅ Completed" also starts with "✅ Complete" so it maps to DEBUG
      expect(mapAgentMessageTypeToLevel('result', '✅ Completed')).toBe(MessageLevel.DEBUG);
      // Content that starts with something else should be RESULT
      expect(mapAgentMessageTypeToLevel('result', 'Complete: done')).toBe(MessageLevel.RESULT);
    });
  });
});
