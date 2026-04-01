/**
 * /research command handler unit tests.
 *
 * Issue #1709 - Research Mode Phase 1.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleResearch } from './research.js';
import { ResearchModeManager } from '../../agents/research-mode.js';
import type { ControlHandlerContext } from '../types.js';

describe('/research command handler', () => {
  let researchManager: ResearchModeManager;
  let context: ControlHandlerContext;

  beforeEach(() => {
    researchManager = new ResearchModeManager();
    context = {
      agentPool: {
        reset: () => {},
        stop: () => false,
      },
      node: {
        nodeId: 'test-node',
        getExecNodes: () => [],
        getDebugGroup: () => null,
        clearDebugGroup: () => {},
      },
      researchMode: researchManager,
    };
  });

  const createCommand = (data?: Record<string, unknown>) => ({
    type: 'research' as const,
    chatId: 'test-chat-1',
    data,
  });

  describe('no action (show help)', () => {
    it('should show usage with normal mode indicator', async () => {
      const result = await handleResearch(createCommand(), context);
      expect(result.success).toBe(true);
      expect(result.message).toContain('Normal');
      expect(result.message).toContain('/research <主题>');
    });

    it('should show research mode indicator when in research mode', async () => {
      // Manually set research mode
      const state = researchManager.getState('test-chat-1');
      state.mode = 'research';
      state.topic = 'ai-safety';

      const result = await handleResearch(createCommand(), context);
      expect(result.success).toBe(true);
      expect(result.message).toContain('Research');
      expect(result.message).toContain('ai-safety');
    });
  });

  describe('research not available', () => {
    it('should return error when researchMode is not configured', async () => {
      const noResearchContext: ControlHandlerContext = {
        ...context,
        researchMode: undefined,
      };

      const result = await handleResearch(createCommand(), noResearchContext);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });
  });

  describe('enter action', () => {
    it('should return error when no topic is provided', async () => {
      const result = await handleResearch(
        createCommand({ action: 'enter', topic: '' }),
        context
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('请指定研究主题');
    });

    it('should return error when topic is missing', async () => {
      const result = await handleResearch(
        createCommand({ action: 'enter' }),
        context
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('请指定研究主题');
    });
  });

  describe('exit action', () => {
    it('should return error when not in research mode', async () => {
      const result = await handleResearch(
        createCommand({ action: 'exit' }),
        context
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('不在研究模式');
    });

    it('should exit research mode successfully', async () => {
      // Set up research mode
      const state = researchManager.getState('test-chat-1');
      state.mode = 'research';
      state.topic = 'test-topic';
      state.researchDir = '/workspace/research/test-topic';
      state.activatedAt = Date.now();

      const result = await handleResearch(
        createCommand({ action: 'exit' }),
        context
      );
      expect(result.success).toBe(true);
      expect(result.message).toContain('已退出');
      expect(result.message).toContain('test-topic');

      // Verify mode is reset
      expect(researchManager.getMode('test-chat-1')).toBe('normal');
    });
  });

  describe('status action', () => {
    it('should show normal mode status', async () => {
      const result = await handleResearch(
        createCommand({ action: 'status' }),
        context
      );
      expect(result.success).toBe(true);
      expect(result.message).toContain('Normal');
    });

    it('should show research mode status with details', async () => {
      const state = researchManager.getState('test-chat-1');
      state.mode = 'research';
      state.topic = 'quantum-computing';
      state.researchDir = '/workspace/research/quantum-computing';
      state.activatedAt = Date.now() - 300000; // 5 minutes ago

      const result = await handleResearch(
        createCommand({ action: 'status' }),
        context
      );
      expect(result.success).toBe(true);
      expect(result.message).toContain('Research');
      expect(result.message).toContain('quantum-computing');
      expect(result.message).toContain('分钟');
    });
  });

  describe('unknown action', () => {
    it('should return error for unknown action', async () => {
      const result = await handleResearch(
        createCommand({ action: 'unknown' }),
        context
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('未知操作');
    });
  });
});
