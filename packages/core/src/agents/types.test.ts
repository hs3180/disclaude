/**
 * Unit tests for Agent type definitions and type guards
 *
 * Issue #1501: Simplified to ChatAgent-only architecture.
 * SkillAgent and Subagent type guards have been removed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isChatAgent,
  isDisposable,
  setRuntimeContext,
  getRuntimeContext,
  hasRuntimeContext,
  clearRuntimeContext,
  type ChatAgent,
  type Disposable,
  type AgentRuntimeContext,
} from './types.js';

describe('Type Guards', () => {
  describe('isChatAgent', () => {
    it('should return true for valid ChatAgent', () => {
      const chatAgent: ChatAgent = {
        type: 'chat',
        name: 'test-agent',
        async start() {},
        async *handleInput() {},
        processMessage() {},
        async executeOnce() {},
        reset() {},
        stop() { return true; },
        dispose() {},
      };

      expect(isChatAgent(chatAgent)).toBe(true);
    });

    it('should return false for null', () => {
      expect(isChatAgent(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isChatAgent(undefined)).toBe(false);
    });

    it('should return false for non-object types', () => {
      expect(isChatAgent('string')).toBe(false);
      expect(isChatAgent(123)).toBe(false);
      expect(isChatAgent(true)).toBe(false);
    });

    it('should return false for wrong type', () => {
      const otherType = { type: 'skill', name: 'test' };
      expect(isChatAgent(otherType)).toBe(false);
    });

    it('should return false for object without type', () => {
      expect(isChatAgent({})).toBe(false);
      expect(isChatAgent({ name: 'test' })).toBe(false);
    });
  });

  describe('isDisposable', () => {
    it('should return true for object with dispose method', () => {
      const disposable: Disposable = {
        dispose: () => {},
      };

      expect(isDisposable(disposable)).toBe(true);
    });

    it('should return true for ChatAgent (which is Disposable)', () => {
      const chatAgent: ChatAgent = {
        type: 'chat',
        name: 'test-agent',
        async start() {},
        async *handleInput() {},
        processMessage() {},
        async executeOnce() {},
        reset() {},
        stop() { return true; },
        dispose() {},
      };

      expect(isDisposable(chatAgent)).toBe(true);
    });

    it('should return false for null', () => {
      expect(isDisposable(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isDisposable(undefined)).toBe(false);
    });

    it('should return false for object without dispose', () => {
      expect(isDisposable({})).toBe(false);
      expect(isDisposable({ name: 'test' })).toBe(false);
    });

    it('should return false when dispose is not a function', () => {
      const invalidDisposable = {
        dispose: 'not a function',
      };

      expect(isDisposable(invalidDisposable)).toBe(false);
    });
  });
});

describe('Runtime Context', () => {
  // Clear context before each test to ensure isolation
  beforeEach(() => {
    clearRuntimeContext();
  });

  afterEach(() => {
    clearRuntimeContext();
  });

  // Helper function to create a minimal valid context
  const createMockContext = (overrides: Partial<AgentRuntimeContext> = {}): AgentRuntimeContext => ({
    getWorkspaceDir: () => '/workspace',
    getAgentConfig: () => ({ apiKey: 'test', model: 'test-model', provider: 'anthropic' as const }),
    getLoggingConfig: () => ({ sdkDebug: false }),
    getGlobalEnv: () => ({}),
    isAgentTeamsEnabled: () => false,
    ...overrides,
  });

  describe('hasRuntimeContext', () => {
    it('should return false when context is not set', () => {
      expect(hasRuntimeContext()).toBe(false);
    });

    it('should return true when context is set', () => {
      setRuntimeContext(createMockContext());
      expect(hasRuntimeContext()).toBe(true);
    });
  });

  describe('getRuntimeContext', () => {
    it('should throw when context is not set', () => {
      expect(() => getRuntimeContext()).toThrow('Runtime context not set');
    });

    it('should return the context when set', () => {
      const ctx = createMockContext();
      setRuntimeContext(ctx);
      const result = getRuntimeContext();

      expect(result).toBe(ctx);
    });

    it('should return context with all methods', () => {
      const ctx: AgentRuntimeContext = {
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'test', model: 'test-model', provider: 'anthropic' }),
        getLoggingConfig: () => ({ sdkDebug: true }),
        getGlobalEnv: () => ({ NODE_ENV: 'test' }),
        isAgentTeamsEnabled: () => true,
        createMcpServer() { return Promise.resolve({}); },
        async sendMessage() {},
        async sendCard() {},
        async sendFile() {},
        findSkill() { return Promise.resolve(undefined); },
      };

      setRuntimeContext(ctx);
      const result = getRuntimeContext();

      expect(result.getWorkspaceDir()).toBe('/workspace');
      expect(result.getAgentConfig()).toEqual({ apiKey: 'test', model: 'test-model', provider: 'anthropic' });
      expect(result.getLoggingConfig()).toEqual({ sdkDebug: true });
      expect(result.getGlobalEnv()).toEqual({ NODE_ENV: 'test' });
      expect(result.isAgentTeamsEnabled()).toBe(true);
    });
  });

  describe('setRuntimeContext', () => {
    it('should set the context', () => {
      const ctx = createMockContext();

      setRuntimeContext(ctx);
      expect(hasRuntimeContext()).toBe(true);
      expect(getRuntimeContext()).toBe(ctx);
    });

    it('should replace existing context', () => {
      const ctx1 = createMockContext({
        getWorkspaceDir: () => '/workspace1',
      });

      const ctx2 = createMockContext({
        getWorkspaceDir: () => '/workspace2',
        isAgentTeamsEnabled: () => true,
      });

      setRuntimeContext(ctx1);
      expect(getRuntimeContext().getWorkspaceDir()).toBe('/workspace1');

      setRuntimeContext(ctx2);
      expect(getRuntimeContext().getWorkspaceDir()).toBe('/workspace2');
    });
  });

  describe('clearRuntimeContext', () => {
    it('should clear the context', () => {
      const ctx = createMockContext();

      setRuntimeContext(ctx);
      expect(hasRuntimeContext()).toBe(true);

      clearRuntimeContext();
      expect(hasRuntimeContext()).toBe(false);
    });

    it('should not throw when called on empty context', () => {
      expect(() => clearRuntimeContext()).not.toThrow();
    });

    it('should allow context to be set again after clearing', () => {
      const ctx1 = createMockContext({
        getWorkspaceDir: () => '/workspace1',
      });

      setRuntimeContext(ctx1);
      clearRuntimeContext();

      const ctx2 = createMockContext({
        getWorkspaceDir: () => '/workspace2',
      });

      setRuntimeContext(ctx2);
      expect(getRuntimeContext().getWorkspaceDir()).toBe('/workspace2');
    });
  });
});
