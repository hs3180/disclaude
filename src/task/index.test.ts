/**
 * Tests for task module exports (src/task/index.ts)
 *
 * Tests the following functionality:
 * - SkillAgent is exported correctly
 * - Supporting modules are exported correctly
 * - Feishu context MCP tools are exported correctly
 * - Utility functions are exported correctly
 *
 * Simplified (Issue #413): Tests SkillAgent instead of Evaluator class.
 * Refactored (Issue #1309): Removed ReflectionController (schedule-driven approach).
 */

import { describe, it, expect } from 'vitest';
import * as TaskModule from './index.js';

describe('Task Module Exports', () => {
  describe('SkillAgent (Issue #413)', () => {
    it('should export SkillAgent', () => {
      expect(TaskModule.SkillAgent).toBeDefined();
      expect(typeof TaskModule.SkillAgent).toBe('function');
    });
  });

  describe('Module Structure', () => {
    it('should have all expected exports', () => {
      const exports = Object.keys(TaskModule);

      // SkillAgent (Issue #413)
      expect(exports).toContain('SkillAgent');

      // Supporting modules
      expect(exports).toContain('DialogueMessageTracker');
      expect(exports).toContain('parseBaseToolName');
      expect(exports).toContain('isUserFeedbackTool');

      // Context tools
      expect(exports).toContain('feishuContextTools');
      expect(exports).toContain('send_message');
      expect(exports).toContain('send_file');

      // Utilities
      expect(exports).toContain('extractText');
    });

    it('should not have undefined exports', () => {
      const exports = Object.values(TaskModule);

      exports.forEach((exported) => {
        expect(exported).not.toBeUndefined();
      });
    });
  });
});
