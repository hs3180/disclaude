/**
 * Tests for TaskSuggestionService.
 *
 * Issue #470: feat: 任务完成后自动推荐下一步操作
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  TaskSuggestionService,
  DEFAULT_TASK_SUGGESTION_CONFIG,
  type SuggestionItem,
} from './task-suggestion-service.js';

describe('TaskSuggestionService', () => {
  let service: TaskSuggestionService;

  beforeEach(() => {
    service = new TaskSuggestionService();
  });

  describe('constructor', () => {
    it('should use default config when no config provided', () => {
      const config = service.getConfig();
      expect(config).toEqual(DEFAULT_TASK_SUGGESTION_CONFIG);
    });

    it('should merge provided config with defaults', () => {
      const customService = new TaskSuggestionService({ maxSuggestions: 2 });
      const config = customService.getConfig();
      expect(config.maxSuggestions).toBe(2);
      expect(config.enabled).toBe(true);
    });
  });

  describe('isEnabled', () => {
    it('should return true when enabled and showAfterTasks is true', () => {
      expect(service.isEnabled()).toBe(true);
    });

    it('should return false when disabled', () => {
      const disabledService = new TaskSuggestionService({ enabled: false });
      expect(disabledService.isEnabled()).toBe(false);
    });

    it('should return false when showAfterTasks is false', () => {
      const noShowService = new TaskSuggestionService({ showAfterTasks: false });
      expect(noShowService.isEnabled()).toBe(false);
    });
  });

  describe('detectTaskType', () => {
    it('should detect file_analysis task type', () => {
      // Access private method via type assertion
      const detectType = (service as unknown as { detectTaskType: (m: string) => string })
        .detectTaskType.bind(service);

      expect(detectType('分析 src 目录的代码结构')).toBe('file_analysis');
      expect(detectType('读取 package.json 文件')).toBe('file_analysis');
      expect(detectType('检查代码结构')).toBe('file_analysis');
    });

    it('should detect code_modification task type', () => {
      const detectType = (service as unknown as { detectTaskType: (m: string) => string })
        .detectTaskType.bind(service);

      expect(detectType('修改配置文件')).toBe('code_modification');
      expect(detectType('添加新功能')).toBe('code_modification');
      expect(detectType('重构这个模块')).toBe('code_modification');
    });

    it('should detect bug_fix task type', () => {
      const detectType = (service as unknown as { detectTaskType: (m: string) => string })
        .detectTaskType.bind(service);

      expect(detectType('修复这个 bug')).toBe('bug_fix');
      expect(detectType('解决错误问题')).toBe('bug_fix');
      expect(detectType('调试异常')).toBe('bug_fix');
    });

    it('should detect info_query task type', () => {
      const detectType = (service as unknown as { detectTaskType: (m: string) => string })
        .detectTaskType.bind(service);

      expect(detectType('查询数据库')).toBe('info_query');
      expect(detectType('搜索相关文件')).toBe('info_query');
      expect(detectType('什么是 TypeScript')).toBe('info_query');
    });

    it('should return general for unrecognized messages', () => {
      const detectType = (service as unknown as { detectTaskType: (m: string) => string })
        .detectTaskType.bind(service);

      expect(detectType('hello world')).toBe('general');
      expect(detectType('random text')).toBe('general');
    });
  });

  describe('generateSuggestions', () => {
    it('should return empty array when disabled', () => {
      const disabledService = new TaskSuggestionService({ enabled: false });
      const suggestions = disabledService.generateSuggestions('分析代码');
      expect(suggestions).toEqual([]);
    });

    it('should return suggestions for file_analysis task', () => {
      const suggestions = service.generateSuggestions('分析 src 目录的代码结构');
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.length).toBeLessThanOrEqual(DEFAULT_TASK_SUGGESTION_CONFIG.maxSuggestions);
      expect(suggestions[0]).toHaveProperty('emoji');
      expect(suggestions[0]).toHaveProperty('description');
    });

    it('should respect maxSuggestions config', () => {
      const limitedService = new TaskSuggestionService({ maxSuggestions: 2 });
      const suggestions = limitedService.generateSuggestions('分析代码');
      expect(suggestions.length).toBeLessThanOrEqual(2);
    });

    it('should return suggestions with examplePrompt', () => {
      const suggestions = service.generateSuggestions('分析代码');
      expect(suggestions.some(s => s.examplePrompt)).toBe(true);
    });
  });

  describe('formatSuggestionsMessage', () => {
    it('should return empty string for empty suggestions', () => {
      const message = service.formatSuggestionsMessage([]);
      expect(message).toBe('');
    });

    it('should format suggestions correctly', () => {
      const suggestions: SuggestionItem[] = [
        { emoji: '📝', description: '生成文档', examplePrompt: '生成 README' },
        { emoji: '🔍', description: '分析依赖' },
      ];
      const message = service.formatSuggestionsMessage(suggestions);

      expect(message).toContain('💡');
      expect(message).toContain('接下来你可以');
      expect(message).toContain('📝');
      expect(message).toContain('生成文档');
      expect(message).toContain('生成 README');
      expect(message).toContain('🔍');
      expect(message).toContain('分析依赖');
    });

    it('should include numbered list', () => {
      const suggestions: SuggestionItem[] = [
        { emoji: '📝', description: '生成文档' },
        { emoji: '🔍', description: '分析依赖' },
      ];
      const message = service.formatSuggestionsMessage(suggestions);

      expect(message).toContain('1.');
      expect(message).toContain('2.');
    });
  });

  describe('generateSuggestionsMessage', () => {
    it('should generate complete suggestions message', () => {
      const message = service.generateSuggestionsMessage('分析代码结构');
      expect(message).toContain('💡');
      expect(message).toContain('接下来你可以');
    });

    it('should return empty string when disabled', () => {
      const disabledService = new TaskSuggestionService({ enabled: false });
      const message = disabledService.generateSuggestionsMessage('分析代码');
      expect(message).toBe('');
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', () => {
      service.updateConfig({ maxSuggestions: 3 });
      expect(service.getConfig().maxSuggestions).toBe(3);
    });

    it('should preserve other config values', () => {
      service.updateConfig({ maxSuggestions: 3 });
      expect(service.getConfig().enabled).toBe(true);
    });
  });

  describe('getConfig', () => {
    it('should return a copy of config', () => {
      const config1 = service.getConfig();
      const config2 = service.getConfig();
      expect(config1).not.toBe(config2); // Different references
      expect(config1).toEqual(config2); // Same values
    });
  });

  describe('task type suggestions', () => {
    it('should provide file_analysis suggestions', () => {
      const suggestions = service.generateSuggestions('分析代码结构');
      const descriptions = suggestions.map(s => s.description);
      expect(descriptions).toContain('生成文档');
    });

    it('should provide code_modification suggestions', () => {
      const suggestions = service.generateSuggestions('修改配置文件');
      const descriptions = suggestions.map(s => s.description);
      expect(descriptions).toContain('运行测试');
    });

    it('should provide bug_fix suggestions', () => {
      const suggestions = service.generateSuggestions('修复这个 bug');
      const descriptions = suggestions.map(s => s.description);
      expect(descriptions).toContain('验证修复');
    });

    it('should provide info_query suggestions', () => {
      const suggestions = service.generateSuggestions('查询相关信息');
      const descriptions = suggestions.map(s => s.description);
      expect(descriptions).toContain('深入分析');
    });

    it('should provide general suggestions for unrecognized tasks', () => {
      const suggestions = service.generateSuggestions('hello world');
      const descriptions = suggestions.map(s => s.description);
      expect(descriptions).toContain('继续工作');
    });
  });
});
