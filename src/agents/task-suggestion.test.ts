/**
 * Tests for TaskSuggestionService.
 *
 * Issue #470: Task completion follow-up suggestions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TaskSuggestionService,
  resetTaskSuggestionService,
  isSuggestionAction,
} from './task-suggestion.js';

// Mock the IAgentSDKProvider
const mockProvider = {
  queryOnce: vi.fn(),
};

vi.mock('../sdk/index.js', () => ({
  getProvider: () => mockProvider,
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('../config/index.js', () => ({
  Config: {
    getAgentConfig: () => ({ model: 'test-model' }),
  },
}));

describe('TaskSuggestionService', () => {
  let service: TaskSuggestionService;

  beforeEach(() => {
    vi.clearAllMocks();
    resetTaskSuggestionService();
    service = new TaskSuggestionService();
  });

  afterEach(() => {
    resetTaskSuggestionService();
  });

  describe('generateSuggestions', () => {
    it('should generate suggestions via LLM', async () => {
      // Create a proper async generator mock
      async function* mockGenerator() {
        yield {
          type: 'result',
          content: JSON.stringify([
            { emoji: '📝', description: '生成文档', prompt: '请为刚才分析的代码结构生成一份 Markdown 文档' },
            { emoji: '🔍', description: '检查问题', prompt: '请检查 src 目录下的代码是否有潜在问题' },
            { emoji: '📊', description: '统计代码行数', prompt: '请统计 src 目录下各模块的代码行数和文件数量' },
          ]),
        };
      }

      mockProvider.queryOnce.mockReturnValue(mockGenerator());

      const result = await service.generateSuggestions({
        userMessage: '帮我分析代码',
        resultContent: '分析完成，src 目录包含 agents/、 channels/、 config/ 等模块...',
      });

      expect(result).toHaveLength(3);
      expect(mockProvider.queryOnce).toHaveBeenCalledTimes(1);
    });

    it('should handle JSON in markdown code block', async () => {
      // Create a proper async generator mock
      async function* mockGenerator() {
        yield {
          type: 'result',
          content: '```json\n[\n  {"emoji": "📝", "description": "生成文档", "prompt": "请生成文档"},\n  {"emoji": "🔍", "description": "检查问题", "prompt": "请检查问题"}\n]\n```',
        };
      }

      mockProvider.queryOnce.mockReturnValue(mockGenerator());

      const result = await service.generateSuggestions({
        userMessage: '帮我分析代码',
        resultContent: '分析完成',
      });

      expect(result).toEqual([
        { emoji: '📝', description: '生成文档', prompt: '请生成文档' },
        { emoji: '🔍', description: '检查问题', prompt: '请检查问题' },
      ]);
    });

    it('should handle plain JSON without code block', async () => {
      // Create a proper async generator mock
      async function* mockGenerator() {
        yield {
          type: 'result',
          content: '[{"emoji": "📝", "description": "生成文档", "prompt": "请生成文档"}, {"emoji": "🔍", "description": "检查问题", "prompt": "请检查问题"}]',
        };
      }

      mockProvider.queryOnce.mockReturnValue(mockGenerator());

      const result = await service.generateSuggestions({
        userMessage: '帮我分析代码',
        resultContent: '分析完成',
      });

      expect(result).toEqual([
        { emoji: '📝', description: '生成文档', prompt: '请生成文档' },
        { emoji: '🔍', description: '检查问题', prompt: '请检查问题' },
      ]);
    });

    it('should handle parse errors', async () => {
      // Create a proper async generator mock
      async function* mockGenerator() {
        yield {
          type: 'result',
          content: 'invalid json',
        };
      }

      mockProvider.queryOnce.mockReturnValue(mockGenerator());

      const result = await service.generateSuggestions({
        userMessage: '帮我分析代码',
        resultContent: '分析完成',
      });

      expect(result).toEqual([]);
      expect(mockProvider.queryOnce).toHaveBeenCalledTimes(1);
    });

    it('should handle LLM errors', async () => {
      mockProvider.queryOnce.mockRejectedValue(new Error('LLM error'));

      const result = await service.generateSuggestions({
        userMessage: '帮我分析代码',
        resultContent: '分析完成',
      });

      expect(result).toEqual([]);
      expect(mockProvider.queryOnce).toHaveBeenCalledTimes(1);
    });
  });

  describe('buildSuggestionCard', () => {
    it('should return null for empty suggestions', () => {
      const card = service.buildSuggestionCard([]);
      expect(card).toBeNull();
    });

    it('should return a card with suggestions', () => {
      const suggestions = [
        { emoji: '📝', description: '生成文档', prompt: '请生成文档' },
        { emoji: '🔍', description: '检查问题', prompt: '请检查问题' },
      ];

      const card = service.buildSuggestionCard(suggestions);

      expect(card).not.toBeNull();
      expect(card).toHaveProperty('config');
      expect(card).toHaveProperty('header');
      expect(card).toHaveProperty('elements');
      expect(card?.header).toMatchObject({
        title: { tag: 'plain_text', content: '💡 接下来你可以' },
        template: 'blue',
      });
    });
  });

  describe('isSuggestionAction', () => {
    it('should return true for valid suggestion action', () => {
      const value = {
        action: 'suggestion',
        prompt: 'test prompt',
        description: 'test description',
      };
      expect(isSuggestionAction(value)).toBe(true);
    });

    it('should return false for invalid values', () => {
      // Missing action field
      expect(isSuggestionAction({})).toBe(false);
      // Missing prompt field
      expect(isSuggestionAction({ action: 'suggestion' })).toBe(false);
      // action is not 'suggestion'
      expect(isSuggestionAction({ action: 'other' })).toBe(false);
      // Not an object
      expect(isSuggestionAction(null)).toBe(false);
      // Not an object
      expect(isSuggestionAction('string')).toBe(false);
    });
  });

  describe('generateSuggestionCard', () => {
    it('should return null when disabled', async () => {
      const disabledService = new TaskSuggestionService({ enabled: false });
      const card = await disabledService.generateSuggestionCard({
        userMessage: 'test',
        resultContent: 'test result',
      });

      expect(card).toBeNull();
    });
  });
});
