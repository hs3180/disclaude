/**
 * Tests for ModelRouter (packages/core/src/config/model-router.ts)
 *
 * Issue #1338: Feature Request - 针对不同场景智能选择最优基座模型
 *
 * Tests the following functionality:
 * - Model routing based on agent type
 * - Fallback to global model when routing disabled
 * - Fallback to global model when no override configured
 * - Explicit model override priority
 * - Configuration validation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ModelRouter, type AgentType, type ModelRouterConfig, type AgentModelConfig } from './model-router.js';

describe('ModelRouter', () => {
  const globalConfig = {
    model: 'glm-4.7',
    provider: 'glm' as const,
    apiBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
  };

  const altGlobalConfig = {
    model: 'claude-3-5-sonnet-20241022',
    provider: 'anthropic' as const,
  };

  describe('constructor', () => {
    it('should create with empty config', () => {
      const router = new ModelRouter();
      expect(router.isEnabled()).toBe(false);
    });

    it('should create with enabled: true but no agents', () => {
      const router = new ModelRouter({ enabled: true });
      expect(router.isEnabled()).toBe(false);
    });

    it('should create with enabled: true and agents', () => {
      const config: ModelRouterConfig = {
        enabled: true,
        agents: {
          skillAgent: { model: 'claude-3-5-sonnet-20241022', provider: 'anthropic' },
        },
      };
      const router = new ModelRouter(config);
      expect(router.isEnabled()).toBe(true);
    });
  });

  describe('isEnabled', () => {
    it('should return false when disabled', () => {
      const router = new ModelRouter({ enabled: false, agents: { skillAgent: { model: 'test' } } });
      expect(router.isEnabled()).toBe(false);
    });

    it('should return false when enabled but no agents configured', () => {
      const router = new ModelRouter({ enabled: true });
      expect(router.isEnabled()).toBe(false);
    });

    it('should return false by default', () => {
      const router = new ModelRouter();
      expect(router.isEnabled()).toBe(false);
    });

    it('should return true when enabled with at least one agent', () => {
      const router = new ModelRouter({
        enabled: true,
        agents: { chatAgent: { model: 'glm-4.7' } },
      });
      expect(router.isEnabled()).toBe(true);
    });
  });

  describe('resolve - routing disabled', () => {
    let router: ModelRouter;

    beforeEach(() => {
      router = new ModelRouter({ enabled: false });
    });

    it('should return global config when routing disabled', () => {
      const result = router.resolve('chatAgent', globalConfig);
      expect(result.model).toBe('glm-4.7');
      expect(result.provider).toBe('glm');
      expect(result.apiBaseUrl).toBe('https://open.bigmodel.cn/api/anthropic');
      expect(result.routed).toBe(false);
      expect(result.agentType).toBe('chatAgent');
    });

    it('should return global config for all agent types when disabled', () => {
      const agentTypes: AgentType[] = ['chatAgent', 'skillAgent', 'scheduleAgent', 'taskAgent', 'subagent'];
      for (const type of agentTypes) {
        const result = router.resolve(type, globalConfig);
        expect(result.model).toBe('glm-4.7');
        expect(result.routed).toBe(false);
        expect(result.agentType).toBe(type);
      }
    });
  });

  describe('resolve - routing enabled with overrides', () => {
    let router: ModelRouter;

    beforeEach(() => {
      router = new ModelRouter({
        enabled: true,
        agents: {
          skillAgent: { model: 'claude-3-5-sonnet-20241022', provider: 'anthropic' },
          chatAgent: { model: 'glm-4.7', provider: 'glm' },
          taskAgent: { model: 'claude-3-opus-20240229', provider: 'anthropic' },
        },
      });
    });

    it('should route skillAgent to coding-optimized model', () => {
      const result = router.resolve('skillAgent', globalConfig);
      expect(result.model).toBe('claude-3-5-sonnet-20241022');
      expect(result.provider).toBe('anthropic');
      expect(result.routed).toBe(true);
      expect(result.agentType).toBe('skillAgent');
    });

    it('should route taskAgent to powerful model', () => {
      const result = router.resolve('taskAgent', globalConfig);
      expect(result.model).toBe('claude-3-opus-20240229');
      expect(result.provider).toBe('anthropic');
      expect(result.routed).toBe(true);
    });

    it('should route chatAgent to efficient model', () => {
      const result = router.resolve('chatAgent', altGlobalConfig);
      expect(result.model).toBe('glm-4.7');
      expect(result.provider).toBe('glm');
      expect(result.routed).toBe(true);
    });

    it('should fallback to global for unconfigured agent types', () => {
      const result = router.resolve('scheduleAgent', globalConfig);
      expect(result.model).toBe('glm-4.7');
      expect(result.provider).toBe('glm');
      expect(result.routed).toBe(false);
    });

    it('should fallback to global for subagent when not configured', () => {
      const result = router.resolve('subagent', globalConfig);
      expect(result.model).toBe('glm-4.7');
      expect(result.routed).toBe(false);
    });
  });

  describe('resolve - apiBaseUrl handling', () => {
    it('should use override apiBaseUrl when specified', () => {
      const router = new ModelRouter({
        enabled: true,
        agents: {
          skillAgent: {
            model: 'claude-3-5-sonnet-20241022',
            provider: 'anthropic',
            apiBaseUrl: 'https://custom.api.com',
          },
        },
      });

      const result = router.resolve('skillAgent', globalConfig);
      expect(result.apiBaseUrl).toBe('https://custom.api.com');
    });

    it('should inherit global apiBaseUrl when override does not specify', () => {
      const router = new ModelRouter({
        enabled: true,
        agents: {
          skillAgent: { model: 'claude-3-5-sonnet-20241022', provider: 'anthropic' },
        },
      });

      const result = router.resolve('skillAgent', globalConfig);
      expect(result.apiBaseUrl).toBe('https://open.bigmodel.cn/api/anthropic');
    });

    it('should handle undefined global apiBaseUrl', () => {
      const router = new ModelRouter({
        enabled: true,
        agents: {
          skillAgent: { model: 'claude-3-5-sonnet-20241022', provider: 'anthropic' },
        },
      });

      const result = router.resolve('skillAgent', { model: 'glm-4.7', provider: 'glm' });
      expect(result.apiBaseUrl).toBeUndefined();
    });
  });

  describe('resolve - provider inheritance', () => {
    it('should use override provider when specified', () => {
      const router = new ModelRouter({
        enabled: true,
        agents: {
          skillAgent: { model: 'claude-3-5-sonnet-20241022', provider: 'anthropic' },
        },
      });

      const result = router.resolve('skillAgent', globalConfig);
      expect(result.provider).toBe('anthropic');
    });

    it('should inherit global provider when override does not specify', () => {
      const router = new ModelRouter({
        enabled: true,
        agents: {
          chatAgent: { model: 'glm-4.7' },
        },
      });

      const result = router.resolve('chatAgent', altGlobalConfig);
      expect(result.provider).toBe('anthropic');
    });
  });

  describe('getConfiguredAgentTypes', () => {
    it('should return empty array for disabled router', () => {
      const router = new ModelRouter();
      expect(router.getConfiguredAgentTypes()).toEqual([]);
    });

    it('should return configured agent types', () => {
      const router = new ModelRouter({
        enabled: true,
        agents: {
          skillAgent: { model: 'claude-3-5-sonnet-20241022' },
          chatAgent: { model: 'glm-4.7' },
        },
      });

      const types = router.getConfiguredAgentTypes();
      expect(types).toContain('skillAgent');
      expect(types).toContain('chatAgent');
      expect(types).toHaveLength(2);
    });
  });

  describe('getAgentConfig', () => {
    it('should return undefined for unconfigured agent type', () => {
      const router = new ModelRouter({
        enabled: true,
        agents: { skillAgent: { model: 'claude-3-5-sonnet-20241022' } },
      });

      expect(router.getAgentConfig('chatAgent')).toBeUndefined();
    });

    it('should return config for configured agent type', () => {
      const config: AgentModelConfig = { model: 'claude-3-5-sonnet-20241022', provider: 'anthropic' };
      const router = new ModelRouter({
        enabled: true,
        agents: { skillAgent: config },
      });

      const result = router.getAgentConfig('skillAgent');
      expect(result).toEqual(config);
    });
  });

  describe('real-world scenarios', () => {
    it('should handle coding vs chat optimization', () => {
      // Scenario: Use GLM for chat (cheaper, faster), Claude for coding (better code)
      const router = new ModelRouter({
        enabled: true,
        agents: {
          chatAgent: { model: 'glm-4.7', provider: 'glm' },
          scheduleAgent: { model: 'glm-4.7', provider: 'glm' },
          skillAgent: { model: 'claude-3-5-sonnet-20241022', provider: 'anthropic' },
          taskAgent: { model: 'claude-3-5-sonnet-20241022', provider: 'anthropic' },
          subagent: { model: 'claude-3-5-sonnet-20241022', provider: 'anthropic' },
        },
      });

      // Chat agents use GLM (faster, cheaper)
      const chatResult = router.resolve('chatAgent', altGlobalConfig);
      expect(chatResult.model).toBe('glm-4.7');
      expect(chatResult.provider).toBe('glm');
      expect(chatResult.routed).toBe(true);

      // Schedule agents use GLM (efficient for routine tasks)
      const scheduleResult = router.resolve('scheduleAgent', altGlobalConfig);
      expect(scheduleResult.model).toBe('glm-4.7');
      expect(scheduleResult.provider).toBe('glm');
      expect(scheduleResult.routed).toBe(true);

      // Skill agents use Claude (better for coding tasks)
      const skillResult = router.resolve('skillAgent', globalConfig);
      expect(skillResult.model).toBe('claude-3-5-sonnet-20241022');
      expect(skillResult.provider).toBe('anthropic');
      expect(skillResult.routed).toBe(true);

      // Task agents use Claude (complex tasks need more capability)
      const taskResult = router.resolve('taskAgent', globalConfig);
      expect(taskResult.model).toBe('claude-3-5-sonnet-20241022');
      expect(taskResult.provider).toBe('anthropic');
      expect(taskResult.routed).toBe(true);
    });

    it('should handle partial configuration (only some agents overridden)', () => {
      const router = new ModelRouter({
        enabled: true,
        agents: {
          skillAgent: { model: 'claude-3-5-sonnet-20241022', provider: 'anthropic' },
        },
      });

      // Only skillAgent has override
      expect(router.resolve('skillAgent', globalConfig).routed).toBe(true);
      expect(router.resolve('skillAgent', globalConfig).model).toBe('claude-3-5-sonnet-20241022');

      // Others use global
      expect(router.resolve('chatAgent', globalConfig).routed).toBe(false);
      expect(router.resolve('chatAgent', globalConfig).model).toBe('glm-4.7');
      expect(router.resolve('taskAgent', globalConfig).routed).toBe(false);
      expect(router.resolve('subagent', globalConfig).routed).toBe(false);
    });
  });
});
