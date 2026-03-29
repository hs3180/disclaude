/**
 * ACP 消息适配器单元测试
 *
 * @see Issue #1333 - 支持OpenAI Agent
 */

import { describe, it, expect } from 'vitest';
import {
  acpNotificationToAgentMessage,
  adaptInputToAcp,
  userInputToAcpMessage,
} from './message-adapter.js';
import type { AcpTaskNotificationParams } from './types.js';
import type { UserInput } from '../../types.js';

describe('ACP Message Adapter', () => {
  describe('userInputToAcpMessage', () => {
    it('should convert string content UserInput to AcpMessage', () => {
      const input: UserInput = { role: 'user' as const, content: 'Hello, world!' };
      const result = userInputToAcpMessage(input);
      expect(result.role).toBe('user');
      expect(result.content).toBe('Hello, world!');
    });

    it('should convert ContentBlock array UserInput to AcpMessage', () => {
      const input: UserInput = {
        role: 'user' as const,
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'image', data: 'base64data', mimeType: 'image/png' },
        ],
      };
      const result = userInputToAcpMessage(input);
      expect(result.role).toBe('user');
      expect(Array.isArray(result.content)).toBe(true);
    });
  });

  describe('adaptInputToAcp', () => {
    it('should convert string input to single AcpMessage', () => {
      const result = adaptInputToAcp('Hello, world!');
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('user');
      expect(result[0].content).toBe('Hello, world!');
    });

    it('should convert UserInput array to AcpMessage array', () => {
      const input: UserInput[] = [
        { role: 'user' as const, content: 'First message' },
        { role: 'user' as const, content: 'Second message' },
      ];
      const result = adaptInputToAcp(input);
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('First message');
      expect(result[1].content).toBe('Second message');
    });
  });

  describe('acpNotificationToAgentMessage', () => {
    it('should convert text notification to AgentMessage', () => {
      const notification: AcpTaskNotificationParams = {
        taskId: 'task-123',
        type: 'text',
        data: { text: 'Hello from agent' },
      };
      const result = acpNotificationToAgentMessage(notification);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('text');
      expect(result!.content).toBe('Hello from agent');
      expect(result!.role).toBe('assistant');
      expect(result!.metadata?.sessionId).toBe('task-123');
    });

    it('should convert tool_use notification to AgentMessage', () => {
      const notification: AcpTaskNotificationParams = {
        taskId: 'task-456',
        type: 'tool_use',
        data: {
          toolUseId: 'tool-789',
          name: 'Bash',
          input: { command: 'ls -la' },
        },
      };
      const result = acpNotificationToAgentMessage(notification);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('tool_use');
      expect(result!.content).toContain('Running: ls -la');
      expect(result!.metadata?.toolName).toBe('Bash');
      expect(result!.metadata?.toolInput).toEqual({ command: 'ls -la' });
    });

    it('should convert tool_progress notification to AgentMessage', () => {
      const notification: AcpTaskNotificationParams = {
        taskId: 'task-789',
        type: 'tool_progress',
        data: {
          toolName: 'Read',
          elapsedMs: 5000,
        },
      };
      const result = acpNotificationToAgentMessage(notification);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('tool_progress');
      expect(result!.content).toContain('Read');
      expect(result!.content).toContain('5.0s');
      expect(result!.metadata?.elapsedMs).toBe(5000);
    });

    it('should convert tool_result notification to AgentMessage', () => {
      const notification: AcpTaskNotificationParams = {
        taskId: 'task-101',
        type: 'tool_result',
        data: {
          toolUseId: 'tool-202',
          content: 'File contents here',
          isError: false,
        },
      };
      const result = acpNotificationToAgentMessage(notification);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('tool_result');
      expect(result!.content).toContain('File contents here');
    });

    it('should convert tool_result error notification to AgentMessage', () => {
      const notification: AcpTaskNotificationParams = {
        taskId: 'task-101',
        type: 'tool_result',
        data: {
          toolUseId: 'tool-202',
          content: 'File not found',
          isError: true,
        },
      };
      const result = acpNotificationToAgentMessage(notification);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('tool_result');
      expect(result!.content).toContain('Tool error');
    });

    it('should convert complete notification with usage to AgentMessage', () => {
      const notification: AcpTaskNotificationParams = {
        taskId: 'task-303',
        type: 'complete',
        data: {
          stopReason: 'end_turn',
          usage: {
            inputTokens: 1000,
            outputTokens: 500,
            totalTokens: 1500,
            costUsd: 0.015,
          },
        },
      };
      const result = acpNotificationToAgentMessage(notification);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('result');
      expect(result!.content).toContain('Complete');
      expect(result!.content).toContain('Cost: $0.0150');
      expect(result!.content).toContain('Tokens: 1.5k');
      expect(result!.metadata?.costUsd).toBe(0.015);
      expect(result!.metadata?.inputTokens).toBe(1000);
      expect(result!.metadata?.outputTokens).toBe(500);
      expect(result!.metadata?.stopReason).toBe('end_turn');
    });

    it('should convert error notification to AgentMessage', () => {
      const notification: AcpTaskNotificationParams = {
        taskId: 'task-404',
        type: 'error',
        data: {
          code: -32001,
          message: 'Task not found',
        },
      };
      const result = acpNotificationToAgentMessage(notification);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('error');
      expect(result!.content).toContain('Task not found');
      expect(result!.content).toContain('-32001');
    });

    it('should return null for unknown notification type', () => {
      const notification = {
        taskId: 'task-999',
        type: 'unknown_type',
        data: {},
      } as unknown as AcpTaskNotificationParams;
      const result = acpNotificationToAgentMessage(notification);
      expect(result).toBeNull();
    });

    it('should format different tool names correctly', () => {
      const toolCases = [
        { name: 'Edit', input: { file_path: '/tmp/test.ts' }, expected: 'Editing: /tmp/test.ts' },
        { name: 'Read', input: { file_path: '/tmp/test.ts' }, expected: 'Reading: /tmp/test.ts' },
        { name: 'Write', input: { file_path: '/tmp/test.ts' }, expected: 'Writing: /tmp/test.ts' },
        { name: 'Grep', input: { pattern: 'TODO' }, expected: 'Searching for "TODO"' },
        { name: 'Glob', input: { pattern: '**/*.ts' }, expected: 'Finding files: **/*.ts' },
      ];

      for (const { name, input, expected } of toolCases) {
        const notification: AcpTaskNotificationParams = {
          taskId: 'task-test',
          type: 'tool_use',
          data: { toolUseId: 'tool-1', name, input },
        };
        const result = acpNotificationToAgentMessage(notification);
        expect(result!.content).toContain(expected);
      }
    });
  });
});
