/**
 * Tests for Agent Types module.
 */

import { describe, it, expect } from 'vitest';
import {
  isChatAgent,
  isTaskAgent,
  isToolAgent,
  type ChatAgentType,
  type TaskAgentType,
  type ToolAgentType,
} from './types.js';

describe('Agent Types', () => {
  describe('Type Guards', () => {
    it('should identify ChatAgent correctly', () => {
      const agent: ChatAgentType = {
        category: 'chat',
        name: 'Pilot',
      };
      expect(isChatAgent(agent)).toBe(true);
      expect(isTaskAgent(agent)).toBe(false);
      expect(isToolAgent(agent)).toBe(false);
    });

    it('should identify TaskAgent correctly', () => {
      const agent: TaskAgentType = {
        category: 'task',
        name: 'Evaluator',
        role: 'evaluator',
      };
      expect(isChatAgent(agent)).toBe(false);
      expect(isTaskAgent(agent)).toBe(true);
      expect(isToolAgent(agent)).toBe(false);
    });

    it('should identify ToolAgent correctly', () => {
      const agent: ToolAgentType = {
        category: 'tool',
        name: 'SiteMiner',
        domain: 'web-scraping',
      };
      expect(isChatAgent(agent)).toBe(false);
      expect(isTaskAgent(agent)).toBe(false);
      expect(isToolAgent(agent)).toBe(true);
    });

    it('should handle all task agent roles', () => {
      const roles: Array<'evaluator' | 'executor' | 'reporter'> = ['evaluator', 'executor', 'reporter'];

      for (const role of roles) {
        const agent: TaskAgentType = {
          category: 'task',
          name: `Test${role}`,
          role,
        };
        expect(isTaskAgent(agent)).toBe(true);
        expect(agent.role).toBe(role);
      }
    });
  });

  describe('Type Definitions', () => {
    it('should have correct category types', () => {
      const chatAgent: ChatAgentType = { category: 'chat', name: 'Test' };
      const taskAgent: TaskAgentType = { category: 'task', name: 'Test', role: 'evaluator' };
      const toolAgent: ToolAgentType = { category: 'tool', name: 'Test', domain: 'test' };

      expect(chatAgent.category).toBe('chat');
      expect(taskAgent.category).toBe('task');
      expect(toolAgent.category).toBe('tool');
    });
  });
});
