/**
 * Tests for AgentFactory (re-exported from @disclaude/core)
 *
 * Issue #2717 Phase 1: Updated to verify the re-export surface is correct.
 * The actual AgentFactory logic is now tested in @disclaude/core.
 * Issue #2345 Phase 5: Tests updated to use unified createAgent() method.
 */

import { describe, it, expect, vi } from 'vitest';

// Self-contained mocks (vi.mock is hoisted, no external references allowed)
vi.mock('@disclaude/core', () => {
  const mockChatAgent = vi.fn();

  return {
    Config: {
      getAgentConfig: vi.fn(() => ({
        apiKey: 'default-key',
        model: 'default-model',
        provider: 'anthropic',
        apiBaseUrl: 'https://api.example.com',
      })),
    },
    ChatAgentImpl: mockChatAgent,
    AgentFactory: {
      createAgent: vi.fn(() => ({})),
    },
    toChatAgentCallbacks: vi.fn((callbacks: any) => ({
      sendMessage: callbacks.sendMessage,
      sendCard: async () => {},
      sendFile: async () => {},
      onDone: async () => {},
    })),
    BaseAgent: vi.fn(),
  };
});

import { AgentFactory, toChatAgentCallbacks } from './factory.js';

const mockCallbacks = {
  sendMessage: vi.fn(),
  sendCard: vi.fn(),
  sendFile: vi.fn(),
  onDone: vi.fn(),
};

describe('toChatAgentCallbacks', () => {
  it('should convert SchedulerCallbacks to ChatAgentCallbacks', () => {
    const schedulerCallbacks = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };

    const result = toChatAgentCallbacks(schedulerCallbacks);

    expect(result.sendMessage).toBe(schedulerCallbacks.sendMessage);
    expect(result.sendCard).toBeInstanceOf(Function);
    expect(result.sendFile).toBeInstanceOf(Function);
    expect(result.onDone).toBeInstanceOf(Function);
  });

  it('should provide no-op implementations for sendCard, sendFile, onDone', async () => {
    const schedulerCallbacks = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };

    const result = toChatAgentCallbacks(schedulerCallbacks);

    // Should not throw
    await expect(result.sendCard('chat', {})).resolves.toBeUndefined();
    await expect(result.sendFile('chat', '/path')).resolves.toBeUndefined();
    await expect(result.onDone?.('chat')).resolves.toBeUndefined();
  });
});

describe('AgentFactory', () => {
  it('should export createAgent as a function', () => {
    expect(AgentFactory.createAgent).toBeInstanceOf(Function);
  });

  it('should call createAgent and return an agent', () => {
    const agent = AgentFactory.createAgent('chat-123', mockCallbacks as any);
    expect(agent).toBeDefined();
  });

  it('should call createAgent with options', () => {
    const agent = AgentFactory.createAgent('chat-456', mockCallbacks as any, {
      apiKey: 'custom-key',
      model: 'custom-model',
    });
    expect(agent).toBeDefined();
  });

  it('should support messageBuilderOptions', () => {
    const agent = AgentFactory.createAgent('chat-mb', mockCallbacks as any, {
      messageBuilderOptions: { headerPrefix: 'test' } as any,
    });
    expect(agent).toBeDefined();
  });

  it('should support channelMcpFactory option', () => {
    const factory = () => ({ type: 'inline' });
    const agent = AgentFactory.createAgent('chat-mcp', mockCallbacks as any, {
      channelMcpFactory: factory,
    });
    expect(agent).toBeDefined();
  });
});
