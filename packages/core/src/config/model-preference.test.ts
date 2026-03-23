/**
 * Tests for model preference resolution (Issue #1338).
 *
 * Tests the following functionality:
 * - Per-agent-type model override resolution
 * - Priority: explicit options > agent-type config > global config
 * - Backward compatibility (no config = global model)
 */

import { describe, it, expect } from 'vitest';
import {
  resolveModelPreference,
  AGENT_TYPES,
  type ModelPreferenceConfig,
  type ModelPreferenceEntry,
} from './model-preference.js';

const globalConfig = {
  apiKey: 'test-key',
  model: 'glm-4.7',
  provider: 'glm' as const,
  apiBaseUrl: 'https://api.example.com',
};

describe('resolveModelPreference', () => {
  describe('priority 3: global fallback', () => {
    it('should return global config when no preference and no options', () => {
      const result = resolveModelPreference('chatAgent', undefined, globalConfig);
      expect(result).toEqual(globalConfig);
    });

    it('should return global config when preference exists but not for this agent type', () => {
      const config: ModelPreferenceConfig = {
        skillAgent: { model: 'claude-sonnet-4-20250514' },
      };
      const result = resolveModelPreference('chatAgent', config, globalConfig);
      expect(result).toEqual(globalConfig);
    });

    it('should return global config when preference has no model', () => {
      const config: ModelPreferenceConfig = {
        chatAgent: { provider: 'anthropic' } as any,
      };
      const result = resolveModelPreference('chatAgent', config, globalConfig);
      expect(result).toEqual(globalConfig);
    });
  });

  describe('priority 2: agent-type config', () => {
    it('should override model for specific agent type', () => {
      const config: ModelPreferenceConfig = {
        skillAgent: { model: 'claude-sonnet-4-20250514' },
      };
      const result = resolveModelPreference('skillAgent', config, globalConfig);
      expect(result.model).toBe('claude-sonnet-4-20250514');
      expect(result.provider).toBe('glm'); // inherits global provider
      expect(result.apiKey).toBe('test-key'); // inherits global apiKey
    });

    it('should override both model and provider', () => {
      const config: ModelPreferenceConfig = {
        skillAgent: {
          model: 'claude-sonnet-4-20250514',
          provider: 'anthropic',
        },
      };
      const result = resolveModelPreference('skillAgent', config, globalConfig);
      expect(result.model).toBe('claude-sonnet-4-20250514');
      expect(result.provider).toBe('anthropic');
    });

    it('should override apiBaseUrl when specified', () => {
      const config: ModelPreferenceConfig = {
        taskAgent: {
          model: 'claude-opus-4-20250514',
          provider: 'anthropic',
          apiBaseUrl: 'https://custom.api.com',
        },
      };
      const result = resolveModelPreference('taskAgent', config, globalConfig);
      expect(result.model).toBe('claude-opus-4-20250514');
      expect(result.provider).toBe('anthropic');
      expect(result.apiBaseUrl).toBe('https://custom.api.com');
    });

    it('should inherit global apiBaseUrl when not overridden', () => {
      const config: ModelPreferenceConfig = {
        scheduleAgent: { model: 'glm-4.7' },
      };
      const result = resolveModelPreference('scheduleAgent', config, globalConfig);
      expect(result.apiBaseUrl).toBe('https://api.example.com');
    });

    it('should handle multiple agent types independently', () => {
      const config: ModelPreferenceConfig = {
        chatAgent: { model: 'glm-4.7' },
        skillAgent: { model: 'claude-sonnet-4-20250514', provider: 'anthropic' },
        taskAgent: { model: 'claude-opus-4-20250514', provider: 'anthropic' },
      };

      const chatResult = resolveModelPreference('chatAgent', config, globalConfig);
      expect(chatResult.model).toBe('glm-4.7');
      expect(chatResult.provider).toBe('glm');

      const skillResult = resolveModelPreference('skillAgent', config, globalConfig);
      expect(skillResult.model).toBe('claude-sonnet-4-20250514');
      expect(skillResult.provider).toBe('anthropic');

      const taskResult = resolveModelPreference('taskAgent', config, globalConfig);
      expect(taskResult.model).toBe('claude-opus-4-20250514');
      expect(taskResult.provider).toBe('anthropic');
    });
  });

  describe('priority 1: explicit options', () => {
    it('should prefer explicit model override over agent-type config', () => {
      const config: ModelPreferenceConfig = {
        skillAgent: { model: 'claude-sonnet-4-20250514' },
      };
      const result = resolveModelPreference('skillAgent', config, globalConfig, {
        model: 'claude-opus-4-20250514',
      });
      expect(result.model).toBe('claude-opus-4-20250514');
    });

    it('should prefer explicit provider override over agent-type config', () => {
      const config: ModelPreferenceConfig = {
        skillAgent: { model: 'claude-sonnet-4-20250514', provider: 'anthropic' },
      };
      const result = resolveModelPreference('skillAgent', config, globalConfig, {
        provider: 'glm',
      });
      expect(result.provider).toBe('glm');
    });

    it('should allow options with no config preference', () => {
      const result = resolveModelPreference('chatAgent', undefined, globalConfig, {
        model: 'custom-model',
        provider: 'anthropic',
      });
      expect(result.model).toBe('custom-model');
      expect(result.provider).toBe('anthropic');
    });

    it('should inherit global apiKey when only model is overridden', () => {
      const config: ModelPreferenceConfig = {
        skillAgent: { model: 'claude-sonnet-4-20250514' },
      };
      const result = resolveModelPreference('skillAgent', config, globalConfig);
      expect(result.apiKey).toBe('test-key');
    });
  });

  describe('AGENT_TYPES constants', () => {
    it('should define all expected agent types', () => {
      expect(AGENT_TYPES.CHAT).toBe('chatAgent');
      expect(AGENT_TYPES.SCHEDULE).toBe('scheduleAgent');
      expect(AGENT_TYPES.TASK).toBe('taskAgent');
      expect(AGENT_TYPES.SKILL).toBe('skillAgent');
      expect(AGENT_TYPES.SUBAGENT).toBe('subagent');
    });
  });

  describe('backward compatibility', () => {
    it('should work with undefined config (no modelPreference section)', () => {
      const result = resolveModelPreference('chatAgent', undefined, globalConfig);
      expect(result).toEqual(globalConfig);
    });

    it('should work with empty config object', () => {
      const result = resolveModelPreference('chatAgent', {}, globalConfig);
      expect(result).toEqual(globalConfig);
    });

    it('should not break with unknown agent type', () => {
      const config: ModelPreferenceConfig = {
        chatAgent: { model: 'custom' },
      };
      const result = resolveModelPreference('unknownAgent', config, globalConfig);
      expect(result).toEqual(globalConfig);
    });
  });
});
