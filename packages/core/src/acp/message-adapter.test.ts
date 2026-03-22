/**
 * Unit tests for ACP message adapter
 */

import { describe, it, expect } from 'vitest';
import { acpUpdateToAgentMessage, agentMessageToAcpUpdate } from './message-adapter.js';
import type { AcpSessionUpdate } from './types.js';
import type { AgentMessage } from '../sdk/types.js';

const TEST_SESSION_ID = 'test-session-123';

describe('acpUpdateToAgentMessage', () => {
  describe('content update', () => {
    it('should convert text content to AgentMessage', () => {
      const update: AcpSessionUpdate = {
        sessionId: TEST_SESSION_ID,
        type: 'content',
        data: {
          type: 'content',
          contentType: 'text',
          content: 'Hello, world!',
        },
      };

      const message = acpUpdateToAgentMessage(update);
      expect(message).not.toBeNull();
      expect(message!.type).toBe('text');
      expect(message!.content).toBe('Hello, world!');
      expect(message!.role).toBe('assistant');
      expect(message!.metadata?.sessionId).toBe(TEST_SESSION_ID);
    });

    it('should convert diff content', () => {
      const update: AcpSessionUpdate = {
        sessionId: TEST_SESSION_ID,
        type: 'content',
        data: {
          type: 'content',
          contentType: 'diff',
          content: '- old\n+ new',
        },
      };

      const message = acpUpdateToAgentMessage(update);
      expect(message).not.toBeNull();
      expect(message!.content).toBe('- old\n+ new');
    });

    it('should convert terminal content', () => {
      const update: AcpSessionUpdate = {
        sessionId: TEST_SESSION_ID,
        type: 'content',
        data: {
          type: 'content',
          contentType: 'terminal',
          content: '$ ls\nfile.txt',
        },
      };

      const message = acpUpdateToAgentMessage(update);
      expect(message).not.toBeNull();
      expect(message!.content).toBe('$ ls\nfile.txt');
    });
  });

  describe('tool_call update', () => {
    it('should convert tool_call to AgentMessage', () => {
      const update: AcpSessionUpdate = {
        sessionId: TEST_SESSION_ID,
        type: 'tool_call',
        data: {
          type: 'tool_call',
          toolCallId: 'tool-123',
          toolName: 'Bash',
          input: { command: 'ls -la' },
        },
      };

      const message = acpUpdateToAgentMessage(update);
      expect(message).not.toBeNull();
      expect(message!.type).toBe('tool_use');
      expect(message!.content).toContain('Running: ls -la');
      expect(message!.metadata?.toolName).toBe('Bash');
      expect(message!.metadata?.toolInput).toEqual({ command: 'ls -la' });
    });

    it('should format tool call without input', () => {
      const update: AcpSessionUpdate = {
        sessionId: TEST_SESSION_ID,
        type: 'tool_call',
        data: {
          type: 'tool_call',
          toolCallId: 'tool-456',
          toolName: 'Unknown',
        },
      };

      const message = acpUpdateToAgentMessage(update);
      expect(message!.content).toBe('🔧 Unknown');
    });
  });

  describe('tool_output update', () => {
    it('should convert tool_output to AgentMessage', () => {
      const update: AcpSessionUpdate = {
        sessionId: TEST_SESSION_ID,
        type: 'tool_output',
        data: {
          type: 'tool_output',
          toolCallId: 'tool-123',
          content: 'file.txt\nfile2.txt',
          isError: false,
        },
      };

      const message = acpUpdateToAgentMessage(update);
      expect(message).not.toBeNull();
      expect(message!.type).toBe('tool_result');
      expect(message!.content).toBe('file.txt\nfile2.txt');
    });
  });

  describe('exec_plan update', () => {
    it('should convert exec_plan to formatted status', () => {
      const update: AcpSessionUpdate = {
        sessionId: TEST_SESSION_ID,
        type: 'exec_plan',
        data: {
          type: 'exec_plan',
          steps: [
            { description: 'Read the file', toolName: 'Read' },
            { description: 'Edit the file', toolName: 'Edit' },
            { description: 'Run tests', toolName: 'Bash' },
          ],
        },
      };

      const message = acpUpdateToAgentMessage(update);
      expect(message).not.toBeNull();
      expect(message!.type).toBe('status');
      expect(message!.content).toContain('1. Read the file (Read)');
      expect(message!.content).toContain('2. Edit the file (Edit)');
      expect(message!.content).toContain('3. Run tests (Bash)');
    });
  });

  describe('mode_update update', () => {
    it('should convert mode_update to status', () => {
      const update: AcpSessionUpdate = {
        sessionId: TEST_SESSION_ID,
        type: 'mode_update',
        data: {
          type: 'mode_update',
          mode: 'ask',
        },
      };

      const message = acpUpdateToAgentMessage(update);
      expect(message).not.toBeNull();
      expect(message!.type).toBe('status');
      expect(message!.role).toBe('system');
      expect(message!.content).toContain('ask');
    });
  });

  describe('completed update', () => {
    it('should convert end_turn completion to result', () => {
      const update: AcpSessionUpdate = {
        sessionId: TEST_SESSION_ID,
        type: 'completed',
        data: {
          type: 'completed',
          stopReason: 'end_turn',
        },
      };

      const message = acpUpdateToAgentMessage(update);
      expect(message).not.toBeNull();
      expect(message!.type).toBe('result');
      expect(message!.content).toContain('completed');
    });

    it('should convert error completion to error', () => {
      const update: AcpSessionUpdate = {
        sessionId: TEST_SESSION_ID,
        type: 'completed',
        data: {
          type: 'completed',
          stopReason: 'error',
        },
      };

      const message = acpUpdateToAgentMessage(update);
      expect(message).not.toBeNull();
      expect(message!.type).toBe('error');
    });

    it('should convert cancelled completion', () => {
      const update: AcpSessionUpdate = {
        sessionId: TEST_SESSION_ID,
        type: 'completed',
        data: {
          type: 'completed',
          stopReason: 'cancelled',
        },
      };

      const message = acpUpdateToAgentMessage(update);
      expect(message).not.toBeNull();
      expect(message!.type).toBe('result');
      expect(message!.content).toContain('cancelled');
    });
  });
});

describe('agentMessageToAcpUpdate', () => {
  describe('text message', () => {
    it('should convert text AgentMessage to content update', () => {
      const message: AgentMessage = {
        type: 'text',
        content: 'Hello!',
        role: 'assistant',
      };

      const update = agentMessageToAcpUpdate(message, TEST_SESSION_ID);
      expect(update).not.toBeNull();
      expect(update!.sessionId).toBe(TEST_SESSION_ID);
      expect(update!.type).toBe('content');
      expect(update!.data.type).toBe('content');
      expect((update!.data as { content: string }).content).toBe('Hello!');
    });
  });

  describe('tool_use message', () => {
    it('should convert tool_use to tool_call update', () => {
      const message: AgentMessage = {
        type: 'tool_use',
        content: '🔧 Running: ls',
        role: 'assistant',
        metadata: {
          toolName: 'Bash',
          toolInput: { command: 'ls' },
          messageId: 'msg-123',
        },
      };

      const update = agentMessageToAcpUpdate(message, TEST_SESSION_ID);
      expect(update).not.toBeNull();
      expect(update!.type).toBe('tool_call');
      const data = update!.data as { type: string; toolName: string; input: unknown };
      expect(data.toolName).toBe('Bash');
      expect(data.input).toEqual({ command: 'ls' });
    });
  });

  describe('tool_result message', () => {
    it('should convert tool_result to tool_output update', () => {
      const message: AgentMessage = {
        type: 'tool_result',
        content: '✓ Done',
        role: 'assistant',
        metadata: { messageId: 'msg-456' },
      };

      const update = agentMessageToAcpUpdate(message, TEST_SESSION_ID);
      expect(update).not.toBeNull();
      expect(update!.type).toBe('tool_output');
      const data = update!.data as { type: string; content: string };
      expect(data.content).toBe('✓ Done');
    });
  });

  describe('result message', () => {
    it('should convert result to completed update', () => {
      const message: AgentMessage = {
        type: 'result',
        content: '✅ Complete',
        role: 'assistant',
      };

      const update = agentMessageToAcpUpdate(message, TEST_SESSION_ID);
      expect(update).not.toBeNull();
      expect(update!.type).toBe('completed');
      const data = update!.data as { type: string; stopReason: string };
      expect(data.stopReason).toBe('end_turn');
    });
  });

  describe('error message', () => {
    it('should convert error to completed update with error stop reason', () => {
      const message: AgentMessage = {
        type: 'error',
        content: '❌ Something went wrong',
        role: 'assistant',
      };

      const update = agentMessageToAcpUpdate(message, TEST_SESSION_ID);
      expect(update).not.toBeNull();
      expect(update!.type).toBe('completed');
      const data = update!.data as { type: string; stopReason: string };
      expect(data.stopReason).toBe('error');
    });
  });

  describe('status message', () => {
    it('should convert status to content update', () => {
      const message: AgentMessage = {
        type: 'status',
        content: '🔄 Compacting...',
        role: 'system',
      };

      const update = agentMessageToAcpUpdate(message, TEST_SESSION_ID);
      expect(update).not.toBeNull();
      expect(update!.type).toBe('content');
      const data = update!.data as { type: string; content: string };
      expect(data.content).toBe('🔄 Compacting...');
    });
  });

  describe('tool_progress message', () => {
    it('should return null for tool_progress (no direct mapping)', () => {
      const message: AgentMessage = {
        type: 'tool_progress',
        content: '⏳ Running...',
        role: 'assistant',
      };

      const update = agentMessageToAcpUpdate(message, TEST_SESSION_ID);
      expect(update).toBeNull();
    });
  });
});
