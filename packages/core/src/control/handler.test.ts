/**
 * Tests for control handler factory (packages/core/src/control/handler.ts)
 *
 * Verifies that:
 * - Recognized commands are dispatched to their handlers
 * - Unrecognized commands (including skill-only commands like /feedback) return
 *   { success: false } with no message, allowing fallthrough to agent/skill processing
 */

import { describe, it, expect, vi } from 'vitest';
import { createControlHandler } from './handler.js';
import type { ControlCommand, ControlCommandType } from '../types/channel.js';
import type { ControlHandlerContext } from './types.js';

/** Create a minimal mock context for testing */
function createMockContext(): ControlHandlerContext {
  return {
    agentPool: {
      reset: vi.fn(),
      stop: vi.fn(),
    },
    node: {
      nodeId: 'test-node',
      getExecNodes: vi.fn().mockReturnValue([]),
      getDebugGroup: vi.fn().mockReturnValue(null),
      clearDebugGroup: vi.fn(),
    },
  };
}

describe('createControlHandler', () => {
  it('should return success for recognized command "help"', async () => {
    const context = createMockContext();
    const handler = createControlHandler(context);

    const command: ControlCommand = {
      type: 'help' as ControlCommandType,
      chatId: 'test-chat',
    };

    const result = await handler(command);

    expect(result.success).toBe(true);
    expect(result.message).toBeDefined();
  });

  it('should return success for recognized command "reset"', async () => {
    const context = createMockContext();
    const handler = createControlHandler(context);

    const command: ControlCommand = {
      type: 'reset' as ControlCommandType,
      chatId: 'test-chat',
    };

    const result = await handler(command);

    expect(result.success).toBe(true);
    expect(context.agentPool.reset).toHaveBeenCalledWith('test-chat');
  });

  it('should return success for recognized command "stop"', async () => {
    const context = createMockContext();
    const handler = createControlHandler(context);

    const command: ControlCommand = {
      type: 'stop' as ControlCommandType,
      chatId: 'test-chat',
    };

    const result = await handler(command);

    expect(result.success).toBe(true);
  });

  it('should return failure with no message for unrecognized skill-only command "feedback"', async () => {
    const context = createMockContext();
    const handler = createControlHandler(context);

    // Simulate /feedback which is a skill, not a system command
    const command: ControlCommand = {
      type: 'feedback' as ControlCommandType,
      chatId: 'test-chat',
    };

    const result = await handler(command);

    // Unrecognized commands should return success:false with no message,
    // allowing the message handler to fall through to agent/skill processing
    expect(result.success).toBe(false);
    expect(result.message).toBeUndefined();
    expect(result.error).toContain('Unknown command');
  });

  it('should return failure with no message for unrecognized command "site-miner"', async () => {
    const context = createMockContext();
    const handler = createControlHandler(context);

    const command: ControlCommand = {
      type: 'site-miner' as ControlCommandType,
      chatId: 'test-chat',
    };

    const result = await handler(command);

    expect(result.success).toBe(false);
    expect(result.message).toBeUndefined();
  });

  it('should return failure for completely unknown command', async () => {
    const context = createMockContext();
    const handler = createControlHandler(context);

    const command: ControlCommand = {
      type: 'nonexistent-command' as ControlCommandType,
      chatId: 'test-chat',
    };

    const result = await handler(command);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown command');
  });

  it('should return failure for switch-node (valid type, no handler yet)', async () => {
    const context = createMockContext();
    const handler = createControlHandler(context);

    // switch-node is a valid ControlCommandType (Primary Node only),
    // but no handler is registered yet — backend switchChatNode() exists
    const command: ControlCommand = {
      type: 'switch-node' as ControlCommandType,
      chatId: 'test-chat',
      targetNodeId: 'target-node-id',
    };

    const result = await handler(command);

    expect(result.success).toBe(false);
    expect(result.message).toBeUndefined();
    expect(result.error).toContain('Unknown command');
  });

  it('should catch errors from failed command execution and return Command failed', async () => {
    const context = createMockContext();
    // Make agentPool.reset throw to trigger the catch block in createControlHandler
    vi.mocked(context.agentPool.reset).mockImplementation(() => {
      throw new Error('Agent pool unavailable');
    });
    const handler = createControlHandler(context);

    const command: ControlCommand = {
      type: 'reset' as ControlCommandType,
      chatId: 'test-chat',
    };

    const result = await handler(command);

    expect(result.success).toBe(false);
    expect(result.message).toBeUndefined();
    expect(result.error).toContain('Command failed');
    expect(result.error).toContain('Agent pool unavailable');
  });
});

describe('getHandler', () => {
  it('should return undefined for skill-only commands', async () => {
    const { getHandler } = await import('./commands/index.js');

    // Skill-only commands should not have registered handlers
    expect(getHandler('feedback' as ControlCommandType)).toBeUndefined();
    expect(getHandler('site-miner' as ControlCommandType)).toBeUndefined();
    expect(getHandler('skill-creator' as ControlCommandType)).toBeUndefined();
    // switch-node is a valid type but handler not yet implemented
    expect(getHandler('switch-node' as ControlCommandType)).toBeUndefined();
  });

  it('should return handler for all registered commands', async () => {
    const { getHandler } = await import('./commands/index.js');

    const registeredTypes: ControlCommandType[] = [
      'help', 'status', 'reset', 'restart', 'stop',
      'list-nodes', 'show-debug', 'clear-debug', 'passive',
      'list-group', 'create-group', 'add-group-member',
      'remove-group-member', 'dissolve-group',
    ];

    for (const type of registeredTypes) {
      expect(getHandler(type)).toBeDefined();
    }
  });
});
