/**
 * Tests for Task Agent Capability module.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskAgentCapability, getTaskAgentTools, TASK_AGENT_TOOLS } from './task-agent-capability.js';
import type { AgentLifecycleEvent, TaskAgentRole } from './types.js';

describe('TaskAgentCapability', () => {
  describe('Constructor', () => {
    it('should create capability with required options', () => {
      const capability = new TaskAgentCapability({
        role: 'evaluator',
        agentName: 'TestEvaluator',
      });

      expect(capability.getRole()).toBe('evaluator');
      expect(capability.getAgentName()).toBe('TestEvaluator');
      expect(capability.getLifecyclePhase()).toBe('created');
      expect(capability.isInitialized()).toBe(false);
    });

    it('should accept lifecycle event callback', () => {
      const onLifecycleEvent = vi.fn();
      const capability = new TaskAgentCapability({
        role: 'executor',
        agentName: 'TestExecutor',
        onLifecycleEvent,
      });

      capability.initialize();

      expect(onLifecycleEvent).toHaveBeenCalled();
      const events = onLifecycleEvent.mock.calls.map(call => call[0]);
      expect(events.some((e: AgentLifecycleEvent) => e.currentPhase === 'initializing')).toBe(true);
      expect(events.some((e: AgentLifecycleEvent) => e.currentPhase === 'ready')).toBe(true);
    });
  });

  describe('Initialization', () => {
    it('should transition lifecycle phases during initialize', () => {
      const phases: string[] = [];
      const capability = new TaskAgentCapability({
        role: 'reporter',
        agentName: 'TestReporter',
        onLifecycleEvent: (event) => phases.push(event.currentPhase),
      });

      capability.initialize();

      expect(phases).toEqual(['initializing', 'ready']);
      expect(capability.isInitialized()).toBe(true);
      expect(capability.getLifecyclePhase()).toBe('ready');
    });

    it('should not reinitialize if already initialized', () => {
      const phases: string[] = [];
      const capability = new TaskAgentCapability({
        role: 'evaluator',
        agentName: 'TestEvaluator',
        onLifecycleEvent: (event) => phases.push(event.currentPhase),
      });

      capability.initialize();
      capability.initialize(); // Second call

      expect(phases).toEqual(['initializing', 'ready']); // No duplicate transitions
    });
  });

  describe('isReady', () => {
    it('should return false before initialization', () => {
      const capability = new TaskAgentCapability({
        role: 'evaluator',
        agentName: 'TestEvaluator',
      });

      expect(capability.isReady()).toBe(false);
    });

    it('should return true after initialization', () => {
      const capability = new TaskAgentCapability({
        role: 'evaluator',
        agentName: 'TestEvaluator',
      });

      capability.initialize();

      expect(capability.isReady()).toBe(true);
    });

    it('should return false after cleanup', () => {
      const capability = new TaskAgentCapability({
        role: 'evaluator',
        agentName: 'TestEvaluator',
      });

      capability.initialize();
      capability.cleanup();

      expect(capability.isReady()).toBe(false);
    });
  });

  describe('Cleanup', () => {
    it('should transition to disposed after cleanup', () => {
      const phases: string[] = [];
      const capability = new TaskAgentCapability({
        role: 'executor',
        agentName: 'TestExecutor',
        onLifecycleEvent: (event) => phases.push(event.currentPhase),
      });

      capability.initialize();
      capability.cleanup();

      expect(phases).toContain('cleanup');
      expect(phases).toContain('disposed');
      expect(capability.getLifecyclePhase()).toBe('disposed');
      expect(capability.isInitialized()).toBe(false);
    });
  });

  describe('getAgentType', () => {
    it('should return correct agent type for evaluator', () => {
      const capability = new TaskAgentCapability({
        role: 'evaluator',
        agentName: 'Evaluator',
      });

      const type = capability.getAgentType();

      expect(type.category).toBe('task');
      expect(type.name).toBe('Evaluator');
      expect(type.role).toBe('evaluator');
    });

    it('should return correct agent type for executor', () => {
      const capability = new TaskAgentCapability({
        role: 'executor',
        agentName: 'Executor',
      });

      const type = capability.getAgentType();

      expect(type.category).toBe('task');
      expect(type.name).toBe('Executor');
      expect(type.role).toBe('executor');
    });

    it('should return correct agent type for reporter', () => {
      const capability = new TaskAgentCapability({
        role: 'reporter',
        agentName: 'Reporter',
      });

      const type = capability.getAgentType();

      expect(type.category).toBe('task');
      expect(type.name).toBe('Reporter');
      expect(type.role).toBe('reporter');
    });
  });

  describe('getFileManager', () => {
    it('should return TaskFileManager instance', () => {
      const capability = new TaskAgentCapability({
        role: 'evaluator',
        agentName: 'TestEvaluator',
      });

      expect(capability.getFileManager()).toBeDefined();
    });
  });
});

describe('getTaskAgentTools', () => {
  it('should return correct tools for evaluator', () => {
    const tools = getTaskAgentTools('evaluator');
    expect(tools).toEqual(['Read', 'Grep', 'Glob', 'Write']);
  });

  it('should return correct tools for executor', () => {
    const tools = getTaskAgentTools('executor');
    expect(tools).toEqual([]);
  });

  it('should return correct tools for reporter', () => {
    const tools = getTaskAgentTools('reporter');
    expect(tools).toEqual(['send_user_feedback', 'send_file_to_feishu']);
  });

  it('should return a copy of the tools array', () => {
    const tools1 = getTaskAgentTools('evaluator');
    const tools2 = getTaskAgentTools('evaluator');
    expect(tools1).not.toBe(tools2); // Different array references
    expect(tools1).toEqual(tools2); // Same content
  });
});

describe('TASK_AGENT_TOOLS', () => {
  it('should have tools defined for all roles', () => {
    const roles: TaskAgentRole[] = ['evaluator', 'executor', 'reporter'];

    for (const role of roles) {
      expect(TASK_AGENT_TOOLS[role]).toBeDefined();
      expect(Array.isArray(TASK_AGENT_TOOLS[role])).toBe(true);
    }
  });
});
