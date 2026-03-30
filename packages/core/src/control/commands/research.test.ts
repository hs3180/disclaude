/**
 * Tests for /research command handler.
 * Issue #1709: Research 模式切换命令
 */

import { describe, it } from 'vitest';
import { expect } from 'chai';
import { handleResearch } from './research.js';
import type { ControlHandlerContext } from '../types.js';

/**
 * Create a mock research mode manager for testing.
 */
function createMockResearchMode() {
  const state: Map<string, { topic: string; researchCwd: string }> = new Map();

  return {
    isEnabled: (chatId: string) => state.has(chatId),
    getTopic: (chatId: string) => state.get(chatId)?.topic,
    getResearchCwd: (chatId: string) => state.get(chatId)?.researchCwd,
    enable: (chatId: string, topic: string) => {
      const researchCwd = `/workspace/research/${topic.replace(/\s+/g, '_')}`;
      state.set(chatId, { topic, researchCwd });
      return researchCwd;
    },
    disable: (chatId: string) => {
      state.delete(chatId);
    },
  };
}

/**
 * Create a mock control handler context.
 */
function createMockContext(): ControlHandlerContext {
  const disposeAgentCalls: string[] = [];
  return {
    agentPool: {
      reset: () => {},
      stop: () => false,
      disposeAgent: (chatId: string) => {
        disposeAgentCalls.push(chatId);
      },
    },
    node: {
      nodeId: 'test-node',
      getExecNodes: () => [],
      getDebugGroup: () => null,
      clearDebugGroup: () => {},
    },
    researchMode: createMockResearchMode(),
    _disposeAgentCalls: disposeAgentCalls,
  } as unknown as ControlHandlerContext & { _disposeAgentCalls: string[] };
}

describe('handleResearch', () => {
  it('should return "not available" when researchMode is not configured', () => {
    const context: ControlHandlerContext = {
      agentPool: { reset: () => {}, stop: () => false },
      node: {
        nodeId: 'test-node',
        getExecNodes: () => [],
        getDebugGroup: () => null,
        clearDebugGroup: () => {},
      },
    };

    const result = handleResearch(
      { type: 'research', chatId: 'chat-1' },
      context
    );

    expect(result.success).to.be.true;
    expect(result.message).to.include('开发中');
  });

  it('should show disabled status when research mode is off (no args)', () => {
    const ctx = createMockContext();

    const result = handleResearch(
      { type: 'research', chatId: 'chat-1' },
      ctx
    );

    expect(result.success).to.be.true;
    expect(result.message).to.include('❌ 未开启');
    expect(result.message).to.include('/research on');
  });

  it('should enable research mode with /research on <topic>', () => {
    const ctx = createMockContext();

    const result = handleResearch(
      { type: 'research', chatId: 'chat-1', data: { args: ['on', 'AI', 'Safety'] } },
      ctx
    );

    expect(result.success).to.be.true;
    expect(result.message).to.include('🔬');
    expect(result.message).to.include('AI Safety');
    expect(result.message).to.include('已开启');

    // Verify agent was disposed for recreation
    expect(ctx._disposeAgentCalls).to.include('chat-1');
  });

  it('should reject /research on without topic', () => {
    const ctx = createMockContext();

    const result = handleResearch(
      { type: 'research', chatId: 'chat-1', data: { args: ['on'] } },
      ctx
    );

    expect(result.success).to.be.false;
    expect(result.message).to.include('请指定研究主题');
  });

  it('should show enabled status with topic and cwd', () => {
    const ctx = createMockContext();

    // First enable
    handleResearch(
      { type: 'research', chatId: 'chat-1', data: { args: ['on', 'Test Topic'] } },
      ctx
    );

    // Then check status
    const result = handleResearch(
      { type: 'research', chatId: 'chat-1' },
      ctx
    );

    expect(result.success).to.be.true;
    expect(result.message).to.include('✅ 已开启');
    expect(result.message).to.include('Test Topic');
    expect(result.message).to.include('/research off');
  });

  it('should disable research mode with /research off', () => {
    const ctx = createMockContext();

    // First enable
    handleResearch(
      { type: 'research', chatId: 'chat-1', data: { args: ['on', 'Test'] } },
      ctx
    );
    ctx._disposeAgentCalls.length = 0; // Reset calls

    // Then disable
    const result = handleResearch(
      { type: 'research', chatId: 'chat-1', data: { args: ['off'] } },
      ctx
    );

    expect(result.success).to.be.true;
    expect(result.message).to.include('已关闭');

    // Verify agent was disposed for recreation
    expect(ctx._disposeAgentCalls).to.include('chat-1');
  });

  it('should handle /research off when not enabled', () => {
    const ctx = createMockContext();

    const result = handleResearch(
      { type: 'research', chatId: 'chat-1', data: { args: ['off'] } },
      ctx
    );

    expect(result.success).to.be.true;
    expect(result.message).to.include('未处于');
  });

  it('should reject invalid arguments', () => {
    const ctx = createMockContext();

    const result = handleResearch(
      { type: 'research', chatId: 'chat-1', data: { args: ['invalid'] } },
      ctx
    );

    expect(result.success).to.be.false;
    expect(result.message).to.include('无效参数');
  });

  it('should handle string args (REST API style)', () => {
    const ctx = createMockContext();

    const result = handleResearch(
      { type: 'research', chatId: 'chat-1', data: { args: 'on My Research Topic' } },
      ctx
    );

    expect(result.success).to.be.true;
    expect(result.message).to.include('My Research Topic');
  });

  it('should handle topic with special characters by sanitizing', () => {
    const ctx = createMockContext();

    const result = handleResearch(
      { type: 'research', chatId: 'chat-1', data: { args: ['on', 'A/B:C*D'] } },
      ctx
    );

    expect(result.success).to.be.true;
    expect(result.message).to.include('A/B:C*D'); // Original topic preserved in message
  });
});
