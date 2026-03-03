/**
 * Tests for Task Suggestion Service.
 *
 * Issue #470: Task completion follow-up suggestions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TaskSuggestionService,
  initTaskSuggestionService,
  getTaskSuggestionService,
  resetTaskSuggestionService,
  type TaskType,
  type SuggestionContext,
} from './task-suggestion.js';

describe('TaskSuggestionService', () => {
  let service: TaskSuggestionService;

  beforeEach(() => {
    resetTaskSuggestionService();
    service = new TaskSuggestionService();
  });

  afterEach(() => {
    resetTaskSuggestionService();
  });

  describe('constructor', () => {
    it('should use default config when no config provided', () => {
      expect(service.isEnabled()).toBe(true);
    });

    it('should merge custom config with defaults', () => {
      const customService = new TaskSuggestionService({ maxSuggestions: 2 });
      expect(customService.isEnabled()).toBe(true);
    });

    it('should respect enabled: false', () => {
      const disabledService = new TaskSuggestionService({ enabled: false });
      expect(disabledService.isEnabled()).toBe(false);
    });
  });

  describe('detectTaskType', () => {
    it('should detect file-analysis task type', () => {
      expect(service.detectTaskType('分析了 src 目录的代码结构')).toBe('file-analysis');
      expect(service.detectTaskType('Analyzed the directory structure')).toBe('file-analysis');
    });

    it('should detect code-modification task type', () => {
      expect(service.detectTaskType('修改了配置文件')).toBe('code-modification');
      expect(service.detectTaskType('Updated the module')).toBe('code-modification');
      expect(service.detectTaskType('重构了代码')).toBe('code-modification');
    });

    it('should detect bug-fix task type', () => {
      expect(service.detectTaskType('修复了登录 bug')).toBe('bug-fix');
      expect(service.detectTaskType('Fixed the error in parser')).toBe('bug-fix');
      expect(service.detectTaskType('解决了问题')).toBe('bug-fix');
    });

    it('should detect information-query task type', () => {
      expect(service.detectTaskType('查询了用户信息')).toBe('information-query');
      expect(service.detectTaskType('Search for related files')).toBe('information-query');
      expect(service.detectTaskType('查找到了配置')).toBe('information-query');
    });

    it('should detect file-operation task type', () => {
      expect(service.detectTaskType('创建了新配置')).toBe('file-operation');
      expect(service.detectTaskType('Deleted the temp')).toBe('file-operation');
      expect(service.detectTaskType('Copy config file')).toBe('file-operation');
    });

    it('should detect test-execution task type', () => {
      expect(service.detectTaskType('运行了测试')).toBe('test-execution');
      expect(service.detectTaskType('Test passed')).toBe('test-execution');
      expect(service.detectTaskType('vitest results')).toBe('test-execution');
    });

    it('should detect documentation task type', () => {
      expect(service.detectTaskType('生成了说明文档')).toBe('documentation');
      expect(service.detectTaskType('Generated readme.md')).toBe('documentation');
    });

    it('should return general for unknown content', () => {
      expect(service.detectTaskType('Hello world')).toBe('general');
      expect(service.detectTaskType('')).toBe('general');
    });
  });

  describe('generateSuggestions', () => {
    it('should return empty string when disabled', () => {
      const disabledService = new TaskSuggestionService({ enabled: false });
      const result = disabledService.generateSuggestions({ taskType: 'file-analysis' });
      expect(result).toBe('');
    });

    it('should generate suggestions for file-analysis', () => {
      const result = service.generateSuggestions({ taskType: 'file-analysis' });
      expect(result).toContain('💡 接下来你可以：');
      expect(result).toContain('📝');
      expect(result).toContain('生成代码结构文档');
    });

    it('should generate suggestions for code-modification', () => {
      const result = service.generateSuggestions({ taskType: 'code-modification' });
      expect(result).toContain('💡 接下来你可以：');
      expect(result).toContain('🧪');
      expect(result).toContain('运行测试验证修改');
    });

    it('should generate suggestions for bug-fix', () => {
      const result = service.generateSuggestions({ taskType: 'bug-fix' });
      expect(result).toContain('💡 接下来你可以：');
      expect(result).toContain('✅');
      expect(result).toContain('验证修复是否生效');
    });

    it('should generate suggestions for general task', () => {
      const result = service.generateSuggestions({ taskType: 'general' });
      expect(result).toContain('💡 接下来你可以：');
    });

    it('should respect maxSuggestions config', () => {
      const limitedService = new TaskSuggestionService({ maxSuggestions: 2 });
      const result = limitedService.generateSuggestions({ taskType: 'file-analysis' });
      // Should have header + 2 suggestions
      const lines = result.split('\n');
      const suggestionLines = lines.filter(line => line.match(/^\d+\./));
      expect(suggestionLines.length).toBe(2);
    });

    it('should include example prompts', () => {
      const result = service.generateSuggestions({ taskType: 'file-analysis' });
      expect(result).toContain('`');  // Code blocks for example prompts
    });
  });

  describe('generateFromResult', () => {
    it('should auto-detect task type and generate suggestions', () => {
      const result = service.generateFromResult('分析了代码结构');
      expect(result).toContain('💡 接下来你可以：');
    });

    it('should return empty string when disabled', () => {
      const disabledService = new TaskSuggestionService({ enabled: false });
      const result = disabledService.generateFromResult('分析了代码结构');
      expect(result).toBe('');
    });
  });
});

describe('Global instance management', () => {
  beforeEach(() => {
    resetTaskSuggestionService();
  });

  afterEach(() => {
    resetTaskSuggestionService();
  });

  it('should initialize and get global service', () => {
    const service = initTaskSuggestionService({ enabled: true });
    expect(getTaskSuggestionService()).toBe(service);
  });

  it('should return null before initialization', () => {
    expect(getTaskSuggestionService()).toBeNull();
  });

  it('should reset global service', () => {
    initTaskSuggestionService({ enabled: true });
    resetTaskSuggestionService();
    expect(getTaskSuggestionService()).toBeNull();
  });
});
