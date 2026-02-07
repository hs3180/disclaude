/**
 * Tests for DialogueOrchestrator (src/agent/dialogue-orchestrator.ts)
 *
 * Tests the following functionality:
 * - Dialogue orchestrator initialization
 * - Message tracker delegation
 * - Cleanup operations
 * - State management
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DialogueOrchestrator } from './dialogue-orchestrator.js';
import type { DialogueOrchestratorConfig } from './dialogue-orchestrator.js';
import type { ManagerConfig } from './manager.js';
import type { WorkerConfig } from './worker.js';

// Mock dependencies
vi.mock('./iteration-bridge.js', () => ({
  IterationBridge: vi.fn(),
}));

vi.mock('./task-plan-extractor.js', () => ({
  TaskPlanExtractor: vi.fn().mockImplementation(() => ({
    extract: vi.fn(() => ({
      taskId: 'test-task-123',
      title: 'Test Task',
      description: 'Test description',
      milestones: [],
      originalRequest: 'test',
      createdAt: new Date().toISOString(),
    })),
  })),
}));

vi.mock('./dialogue-message-tracker.js', () => {
  let messageSent = false;
  return {
    DialogueMessageTracker: vi.fn().mockImplementation(() => ({
      recordMessageSent: vi.fn(() => {
        messageSent = true;
      }),
      hasAnyMessage: vi.fn(() => messageSent),
      reset: vi.fn(() => {
        messageSent = false;
      }),
      buildWarning: vi.fn(() => 'Warning message'),
    })),
  };
});

vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('DialogueOrchestrator', () => {
  let orchestrator: DialogueOrchestrator;
  let config: DialogueOrchestratorConfig;
  let managerConfig: ManagerConfig;
  let workerConfig: WorkerConfig;

  beforeEach(() => {
    vi.clearAllMocks();

    managerConfig = {
      apiKey: 'test-manager-key',
      model: 'claude-3-5-sonnet-20241022',
    };

    workerConfig = {
      apiKey: 'test-worker-key',
      model: 'claude-3-5-sonnet-20241022',
    };

    config = {
      managerConfig,
      workerConfig,
    };

    orchestrator = new DialogueOrchestrator(config);
  });

  describe('constructor', () => {
    it('should create orchestrator with config', () => {
      expect(orchestrator).toBeInstanceOf(DialogueOrchestrator);
      expect(orchestrator.managerConfig).toBe(managerConfig);
      expect(orchestrator.workerConfig).toBe(workerConfig);
    });

    it('should set max iterations from constants', () => {
      expect(orchestrator.maxIterations).toBeGreaterThan(0);
    });

    it('should accept optional callback', () => {
      const onTaskPlanGenerated = vi.fn();
      const configWithCallback: DialogueOrchestratorConfig = {
        ...config,
        onTaskPlanGenerated,
      };

      const bridge = new DialogueOrchestrator(configWithCallback);
      expect(bridge).toBeInstanceOf(DialogueOrchestrator);
    });

    it('should initialize message tracker', () => {
      const tracker = orchestrator.getMessageTracker();
      expect(tracker).toBeDefined();
      expect(tracker.hasAnyMessage()).toBe(false);
    });
  });

  describe('getMessageTracker', () => {
    it('should return message tracker instance', () => {
      const tracker = orchestrator.getMessageTracker();
      expect(tracker).toBeDefined();
    });

    it('should return same tracker instance on multiple calls', () => {
      const tracker1 = orchestrator.getMessageTracker();
      const tracker2 = orchestrator.getMessageTracker();
      expect(tracker1).toBe(tracker2);
    });
  });

  describe('message tracking delegation', () => {
    it('should delegate message tracking to DialogueMessageTracker', () => {
      const tracker = orchestrator.getMessageTracker();

      tracker.recordMessageSent();
      expect(tracker.hasAnyMessage()).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('should reset all state variables', () => {
      // Set some state via message tracker
      const tracker = orchestrator.getMessageTracker();
      tracker.recordMessageSent();

      // Cleanup
      orchestrator.cleanup();

      // Should reset to initial state
      expect(tracker.hasAnyMessage()).toBe(false);
    });

    it('should not throw on multiple cleanups', () => {
      orchestrator.cleanup();
      expect(() => orchestrator.cleanup()).not.toThrow();
    });
  });

  describe('state management', () => {
    it('should provide message tracker for state tracking', () => {
      const tracker = orchestrator.getMessageTracker();
      expect(tracker).toBeDefined();
      // State is now managed through the message tracker
      expect(typeof tracker.recordMessageSent).toBe('function');
      expect(typeof tracker.hasAnyMessage).toBe('function');
    });

    it('should have cleanup method for state reset', () => {
      expect(typeof orchestrator.cleanup).toBe('function');
    });

    it('should have runDialogue method for execution', () => {
      expect(typeof orchestrator.runDialogue).toBe('function');
    });
  });

  describe('error handling', () => {
    it('should handle errors gracefully during cleanup', () => {
      // Should not throw even if called multiple times or in weird states
      orchestrator.cleanup();
      orchestrator.cleanup();
      expect(() => orchestrator.cleanup()).not.toThrow();
    });
  });
});
