/**
 * Tests for Task Skill MCP (src/mcp/task-skill-mcp.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskFlowOrchestrator } from '../feishu/task-flow-orchestrator.js';

// Mock the SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: vi.fn((name, description, _schema, handler) => ({ name, description, handler })),
  createSdkMcpServer: vi.fn((config: any) => config),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

describe('Task Skill MCP', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('setTaskFlowOrchestrator', () => {
    it('should be exported', async () => {
      const { setTaskFlowOrchestrator } = await import('./task-skill-mcp.js');
      expect(typeof setTaskFlowOrchestrator).toBe('function');
    });
  });

  describe('startDialogueTool', () => {
    it('should be exported', async () => {
      const { startDialogueTool } = await import('./task-skill-mcp.js');
      expect(startDialogueTool).toBeDefined();
    });

    it('should have correct tool name', async () => {
      const { startDialogueTool } = await import('./task-skill-mcp.js');
      expect(startDialogueTool.name).toBe('start_dialogue');
    });

    it('should have description', async () => {
      const { startDialogueTool } = await import('./task-skill-mcp.js');
      expect(startDialogueTool.description).toContain('Dialogue');
    });
  });

  describe('taskSkillSdkMcpServer', () => {
    it('should be exported', async () => {
      const { taskSkillSdkMcpServer } = await import('./task-skill-mcp.js');
      expect(taskSkillSdkMcpServer).toBeDefined();
    });

    it('should have correct name', async () => {
      const { taskSkillSdkMcpServer } = await import('./task-skill-mcp.js');
      expect(taskSkillSdkMcpServer.name).toBe('task-skill');
    });

    it('should have version', async () => {
      const { taskSkillSdkMcpServer } = await import('./task-skill-mcp.js');
      expect((taskSkillSdkMcpServer as any).version).toBe('1.0.0');
    });

    it('should have tools', async () => {
      const { taskSkillSdkMcpServer } = await import('./task-skill-mcp.js');
      expect(Array.isArray((taskSkillSdkMcpServer as any).tools)).toBe(true);
      expect((taskSkillSdkMcpServer as any).tools.length).toBeGreaterThan(0);
    });
  });

  describe('start_dialogue tool handler', () => {
    it('should return soft error when orchestrator not registered', async () => {
      const { startDialogueTool } = await import('./task-skill-mcp.js');

      const result = await startDialogueTool.handler(
        { messageId: 'msg-123', chatId: 'chat-456' },
        undefined as any
      );

      // Should return soft error (no isError flag) to allow agent to continue
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Failed to start dialogue');
      expect(result.content[0].text).toContain('TaskFlowOrchestrator not registered');
    });

    it('should return success when orchestrator is registered', async () => {
      const { setTaskFlowOrchestrator, startDialogueTool } = await import('./task-skill-mcp.js');

      // Register a mock orchestrator
      const mockOrchestrator: Partial<TaskFlowOrchestrator> = {
        executeDialoguePhase: vi.fn().mockResolvedValue(undefined),
      };
      setTaskFlowOrchestrator(mockOrchestrator as TaskFlowOrchestrator);

      const result = await startDialogueTool.handler(
        { messageId: 'msg-123', chatId: 'chat-456' },
        undefined as any
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('✅');
      expect(mockOrchestrator.executeDialoguePhase).toHaveBeenCalledWith(
        'chat-456',
        'msg-123',
        ''
      );
    });
  });
});
