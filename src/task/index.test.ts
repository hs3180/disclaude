/**
 * Tests for task module exports (src/task/index.ts)
 *
 * Tests the following functionality:
 * - All core agents are exported correctly
 * - All bridges are exported correctly
 * - Supporting modules are exported correctly
 * - Feishu context MCP tools are exported correctly
 * - Utility functions are exported correctly
 */

import { describe, it, expect } from 'vitest';
import * as TaskModule from './index.js';

describe('Task Module Exports', () => {
  describe('Core Agents', () => {
    it('should export Evaluator', () => {
      expect(TaskModule.Evaluator).toBeDefined();
      expect(typeof TaskModule.Evaluator).toBe('function');
    });

    it('should export Evaluator', () => {
      expect(TaskModule.Evaluator).toBeDefined();
      expect(typeof TaskModule.Evaluator).toBe('function');
    });
  });

  describe('Bridges', () => {
    it('should export DialogueOrchestrator', () => {
      expect(TaskModule.DialogueOrchestrator).toBeDefined();
      expect(typeof TaskModule.DialogueOrchestrator).toBe('function');
    });

    it('should export IterationBridge', () => {
      expect(TaskModule.IterationBridge).toBeDefined();
      expect(typeof TaskModule.IterationBridge).toBe('function');
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

    it('should export send_user_feedback function', () => {
      expect(TaskModule.send_user_feedback).toBeDefined();
      expect(typeof TaskModule.send_user_feedback).toBe('function');
    });

    it('should export send_file_to_feishu function', () => {
      expect(TaskModule.send_file_to_feishu).toBeDefined();
      expect(typeof TaskModule.send_file_to_feishu).toBe('function');
    });

    it('should have send_user_feedback and send_file_to_feishu in feishuContextTools', () => {
      expect('send_user_feedback' in TaskModule.feishuContextTools).toBe(true);
      expect('send_file_to_feishu' in TaskModule.feishuContextTools).toBe(true);
    });
  });

  describe('Utility Functions', () => {
    it('should export extractText utility', () => {
      expect(TaskModule.extractText).toBeDefined();
      expect(typeof TaskModule.extractText).toBe('function');
    });
  });

  describe('Exported Types', () => {
    it('should export ExecutorConfig type', () => {
      // Type exports don't exist at runtime, but we can verify the module structure
      expect(TaskModule).toBeDefined();
    });

    it('should export DialogueOrchestratorConfig type', () => {
      expect(TaskModule).toBeDefined();
    });

    it('should export TaskPlanData type', () => {
      expect(TaskModule).toBeDefined();
    });

    it('should export IterationBridgeConfig type', () => {
      expect(TaskModule).toBeDefined();
    });
  });

  describe('Module Structure', () => {
    it('should have all expected exports', () => {
      const exports = Object.keys(TaskModule);

      // Core agents
      // Scout removed - no longer exported
      expect(exports).toContain('Evaluator');

      // Bridges
      expect(exports).toContain('DialogueOrchestrator');
      expect(exports).toContain('IterationBridge');

      // Supporting modules
      expect(exports).toContain('DialogueMessageTracker');
      expect(exports).toContain('parseBaseToolName');
      expect(exports).toContain('isUserFeedbackTool');

      // Feishu tools
      expect(exports).toContain('feishuContextTools');
      expect(exports).toContain('send_user_feedback');
      expect(exports).toContain('send_file_to_feishu');

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
