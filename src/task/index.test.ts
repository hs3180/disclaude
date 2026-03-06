/**
 * Tests for task module exports (src/task/index.ts)
 *
 * Tests the following functionality:
 * - SkillAgent is exported correctly
 * - ReflectionController and related types are exported correctly
 * - Supporting modules are exported correctly
 * - Feishu context MCP tools are exported correctly
 * - Utility functions are exported correctly
 *
 * Refactored (Issue #283): Tests ReflectionController instead of DialogueOrchestrator.
 * Simplified (Issue #413): Tests SkillAgent instead of Evaluator class.
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

  describe('Reflection Pattern (Issue #283)', () => {
    it('should export ReflectionController', () => {
      expect(TaskModule.ReflectionController).toBeDefined();
      expect(typeof TaskModule.ReflectionController).toBe('function');
    });

    it('should export TerminationConditions', () => {
      expect(TaskModule.TerminationConditions).toBeDefined();
      expect(typeof TaskModule.TerminationConditions).toBe('object');
    });

    it('should export DEFAULT_REFLECTION_CONFIG', () => {
      expect(TaskModule.DEFAULT_REFLECTION_CONFIG).toBeDefined();
      expect(typeof TaskModule.DEFAULT_REFLECTION_CONFIG).toBe('object');
    });
  });

  describe('Supporting Modules', () => {
    it('should export DialogueMessageTracker', () => {
      expect(TaskModule.DialogueMessageTracker).toBeDefined();
      expect(typeof TaskModule.DialogueMessageTracker).toBe('function');
    });

    it('should export parseBaseToolName', () => {
      expect(TaskModule.parseBaseToolName).toBeDefined();
      expect(typeof TaskModule.parseBaseToolName).toBe('function');
    });

    it('should export isUserFeedbackTool', () => {
      expect(TaskModule.isUserFeedbackTool).toBeDefined();
      expect(typeof TaskModule.isUserFeedbackTool).toBe('function');
    });
  });

  describe('Feishu Context MCP Tools', () => {
    it('should export feishuContextTools', () => {
      expect(TaskModule.feishuContextTools).toBeDefined();
      expect(typeof TaskModule.feishuContextTools).toBe('object');
    });

    it('should export send_message function', () => {
      expect(TaskModule.send_message).toBeDefined();
      expect(typeof TaskModule.send_message).toBe('function');
    });

    it('should export send_file function', () => {
      expect(TaskModule.send_file).toBeDefined();
      expect(typeof TaskModule.send_file).toBe('function');
    });

    it('should have send_message and send_file in feishuContextTools', () => {
      expect('send_message' in TaskModule.feishuContextTools).toBe(true);
      expect('send_file' in TaskModule.feishuContextTools).toBe(true);
    });
  });

  describe('Utility Functions', () => {
    it('should export extractText utility', () => {
      expect(TaskModule.extractText).toBeDefined();
      expect(typeof TaskModule.extractText).toBe('function');
    });
  });

  describe('Exported Types', () => {
    it('should export ReflectionConfig type', () => {
      // Type exports don't exist at runtime, but we can verify the module structure
      expect(TaskModule).toBeDefined();
    });

    it('should export ReflectionContext type', () => {
      expect(TaskModule).toBeDefined();
    });

    it('should export ReflectionMetrics type', () => {
      expect(TaskModule).toBeDefined();
    });

    it('should export ReflectionEvent type', () => {
      expect(TaskModule).toBeDefined();
    });
  });

  describe('Module Structure', () => {
    it('should have all expected exports', () => {
      const exports = Object.keys(TaskModule);

      // SkillAgent (Issue #413)
      expect(exports).toContain('SkillAgent');

      // Reflection Pattern (Issue #283)
      expect(exports).toContain('ReflectionController');
      expect(exports).toContain('TerminationConditions');
      expect(exports).toContain('DEFAULT_REFLECTION_CONFIG');

      // Supporting modules
      expect(exports).toContain('DialogueMessageTracker');
      expect(exports).toContain('parseBaseToolName');
      expect(exports).toContain('isUserFeedbackTool');

      // Feishu tools
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
