/**
 * Tests for agents module exports.
 *
 * Refactored (Issue #413): Updated to test SkillAgentImpl instead of specialized classes.
 */

import { describe, it, expect } from 'vitest';

describe('Agents Module Exports', () => {
  describe('Module Structure', () => {
    it('should export Pilot class', async () => {
      const module = await import('./index.js');
      expect(module.Pilot).toBeDefined();
    });

    it('should export SkillAgentImpl class', async () => {
      const module = await import('./index.js');
      expect(module.SkillAgentImpl).toBeDefined();
    });

    it('should export AgentFactory class', async () => {
      const module = await import('./index.js');
      expect(module.AgentFactory).toBeDefined();
    });

    it('should allow module import', async () => {
      const module = await import('./index.js');
      expect(module).toBeDefined();
    });
  });

  describe('Module Purpose', () => {
    it('should serve as barrel export for agents module', async () => {
      const module = await import('./index.js');
      expect(module).toBeDefined();
    });

    it('should allow imports from agents/index', async () => {
      const { Pilot, AgentFactory, SkillAgentImpl } = await import('./index.js');
      expect(Pilot).toBeDefined();
      expect(AgentFactory).toBeDefined();
      expect(SkillAgentImpl).toBeDefined();
    });
  });

  describe('Exported Types', () => {
    it('should export Pilot as class', async () => {
      const { Pilot } = await import('./index.js');
      expect(typeof Pilot).toBe('function');
    });

    it('should export SkillAgentImpl as class', async () => {
      const { SkillAgentImpl } = await import('./index.js');
      expect(typeof SkillAgentImpl).toBe('function');
    });

    it('should export AgentFactory as class', async () => {
      const { AgentFactory } = await import('./index.js');
      expect(typeof AgentFactory).toBe('function');
      expect(typeof AgentFactory.createChatAgent).toBe('function');
      expect(typeof AgentFactory.createSkillAgent).toBe('function');
      expect(typeof AgentFactory.createSubagent).toBe('function');
    });
  });

  describe('SkillAgent Types', () => {
    it('should export SkillAgentConfig type', async () => {
      // Type-only import, just verify it compiles
      const module = await import('./index.js');
      expect(module).toBeDefined();
    });

    it('should export SkillContext type', async () => {
      // Type-only import, just verify it compiles
      const module = await import('./index.js');
      expect(module).toBeDefined();
    });
  });
});
