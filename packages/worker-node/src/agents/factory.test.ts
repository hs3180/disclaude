/**
 * Tests for AgentFactory backward compatibility re-exports
 * (packages/worker-node/src/agents/factory.ts)
 *
 * Issue #2717 Phase 1: AgentFactory migrated to @disclaude/core.
 * This test verifies that the re-exports from worker-node still work.
 * The actual implementation tests are in @disclaude/core.
 */

import { describe, it, expect } from 'vitest';

import { AgentFactory, toChatAgentCallbacks } from './factory.js';

describe('AgentFactory re-export', () => {
  it('should re-export AgentFactory from @disclaude/core', () => {
    expect(AgentFactory).toBeDefined();
    expect(typeof AgentFactory.createAgent).toBe('function');
  });

  it('should re-export toChatAgentCallbacks from @disclaude/core', () => {
    expect(toChatAgentCallbacks).toBeDefined();
    expect(typeof toChatAgentCallbacks).toBe('function');
  });

  it('toChatAgentCallbacks should work through re-export', () => {
    const schedulerCallbacks = {
      sendMessage: async () => {},
    };

    const result = toChatAgentCallbacks(schedulerCallbacks);

    expect(result.sendMessage).toBe(schedulerCallbacks.sendMessage);
    expect(typeof result.sendCard).toBe('function');
    expect(typeof result.sendFile).toBe('function');
    expect(typeof result.onDone).toBe('function');
  });
});
