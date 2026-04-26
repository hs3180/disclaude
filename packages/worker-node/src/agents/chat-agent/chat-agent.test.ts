/**
 * Tests for ChatAgent backward compatibility re-exports
 * (packages/worker-node/src/agents/chat-agent/index.ts)
 *
 * Issue #2717 Phase 1: ChatAgent migrated to @disclaude/core.
 * This test verifies that the re-exports from worker-node still work
 * and provide the expected interface.
 * The actual implementation tests are in @disclaude/core.
 */

import { describe, it, expect } from 'vitest';

import { ChatAgent, type ChatAgentCallbacks, type ChatAgentConfig, type MessageData } from './index.js';

describe('ChatAgent re-export', () => {
  it('should re-export ChatAgent class from @disclaude/core', () => {
    expect(ChatAgent).toBeDefined();
    expect(typeof ChatAgent).toBe('function');
  });

  it('should have the correct class name', () => {
    expect(ChatAgent.name).toBe('ChatAgent');
  });
});

describe('Type re-exports', () => {
  it('should re-export ChatAgentCallbacks type (compile-time check)', () => {
    // This test verifies the type is properly re-exported at compile time
    // If the type is not exported, TypeScript would fail to compile
    const _callbacks: ChatAgentCallbacks = {
      sendMessage: async () => {},
      sendCard: async () => {},
      sendFile: async () => {},
    };
    expect(_callbacks).toBeDefined();
  });

  it('should re-export ChatAgentConfig type (compile-time check)', () => {
    const _config: Partial<ChatAgentConfig> = {
      chatId: 'test-chat',
    };
    expect(_config).toBeDefined();
  });

  it('should re-export MessageData type (compile-time check)', () => {
    const _data: MessageData = {
      text: 'test',
    };
    expect(_data).toBeDefined();
  });
});
