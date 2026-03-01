/**
 * Tests for agents module exports.
 */

import { describe, it, expect } from 'vitest';

describe('Agents Module Exports', () => {
  describe('Module Structure', () => {
    it('should export Pilot class', async () => {
      const module = await import('./index.js');
      expect(module.Pilot).toBeDefined();
    });

    it('should export SkillAgent class', async () => {
      const module = await import('./index.js');
      expect(module.SkillAgent).toBeDefined();
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
      const { Pilot, AgentFactory, SkillAgent } = await import('./index.js');
      expect(Pilot).toBeDefined();
      expect(AgentFactory).toBeDefined();
      expect(SkillAgent).toBeDefined();
    });
  });

  describe('Exported Types', () => {
    it('should export Pilot as class', async () => {
      const { Pilot } = await import('./index.js');
      expect(typeof Pilot).toBe('function');
    });

    it('should export SkillAgent as class', async () => {
      const { SkillAgent } = await import('./index.js');
      expect(typeof SkillAgent).toBe('function');
    });

    it('should export AgentFactory as class', async () => {
      const { AgentFactory } = await import('./index.js');
      expect(typeof AgentFactory).toBe('function');
      expect(typeof AgentFactory.createChatAgent).toBe('function');
      expect(typeof AgentFactory.createSkillAgent).toBe('function');
      expect(typeof AgentFactory.createSubagent).toBe('function');
    });
  });
});
