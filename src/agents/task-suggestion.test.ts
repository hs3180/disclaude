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
  isSuggestionAction,
  type SuggestionActionValue,
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

  describe('generateSuggestionCard', () => {
    it('should return null when disabled', () => {
      const disabledService = new TaskSuggestionService({ enabled: false });
      const result = disabledService.generateSuggestionCard({ taskType: 'file-analysis' });
      expect(result).toBeNull();
    });

    it('should generate card for file-analysis', () => {
      const result = service.generateSuggestionCard({ taskType: 'file-analysis' });
      expect(result).not.toBeNull();
      expect(result?.header?.title?.content).toContain('接下来你可以');
      expect(result?.elements.length).toBeGreaterThan(0);
    });

    it('should generate card for code-modification', () => {
      const result = service.generateSuggestionCard({ taskType: 'code-modification' });
      expect(result).not.toBeNull();
      expect(result?.header?.title?.content).toContain('接下来你可以');
    });

    it('should generate card for bug-fix', () => {
      const result = service.generateSuggestionCard({ taskType: 'bug-fix' });
      expect(result).not.toBeNull();
      expect(result?.header?.title?.content).toContain('接下来你可以');
    });

    it('should respect maxSuggestions config', () => {
      const customService = new TaskSuggestionService({ maxSuggestions: 2 });
      const result = customService.generateSuggestionCard({ taskType: 'file-analysis' });

      // Count the number of buttons in the card
      let buttonCount = 0;
      for (const element of result?.elements || []) {
        if (element.tag === 'action') {
          buttonCount += element.actions.length;
        }
      }
      expect(buttonCount).toBeLessThanOrEqual(2);
    });

    it('should generate card with correct structure', () => {
      const result = service.generateSuggestionCard({ taskType: 'general' });

      // Check card structure
      expect(result?.config?.wide_screen_mode).toBe(true);
      expect(result?.header?.template).toBe('blue');

      // Should have divider and action groups
      const hasDivider = result?.elements.some((e) => e.tag === 'hr');
      expect(hasDivider).toBe(true);

      const hasAction = result?.elements.some((e) => e.tag === 'action');
      expect(hasAction).toBe(true);
    });
  });

  describe('generateFromResult', () => {
    it('should return null when disabled', () => {
      const disabledService = new TaskSuggestionService({ enabled: false });
      const result = disabledService.generateFromResult('分析完成');
      expect(result).toBeNull();
    });

    it('should auto-detect task type and generate card', () => {
      const result = service.generateFromResult('分析了 src 目录结构');
      expect(result).not.toBeNull();
      expect(result?.header?.title?.content).toContain('接下来你可以');
    });

    it('should generate card for general content', () => {
      const result = service.generateFromResult('一些随机内容');
      expect(result).not.toBeNull();
    });
  });

  describe('button value format', () => {
    it('should contain action and prompt in button value', () => {
      const result = service.generateSuggestionCard({ taskType: 'file-analysis' });
      expect(result).not.toBeNull();

      // Find an action element
      const actionElement = result?.elements.find((e) => e.tag === 'action');
      expect(actionElement).toBeDefined();

      if (actionElement && actionElement.tag === 'action') {
        const button = actionElement.actions[0];
        if (button.tag === 'button') {
          // Button value is a JSON string
          const valueStr = button.value as unknown as string;
          expect(typeof valueStr).toBe('string');
          const value = JSON.parse(valueStr as string) as { action?: string; prompt?: string };
          expect(value.action).toBe('suggestion');
          expect(typeof value.prompt).toBe('string');
        }
      }
    });
  });

  describe('Global Instance Management', () => {
    it('should initialize and get global service', () => {
      resetTaskSuggestionService();
      expect(getTaskSuggestionService()).toBeNull();

      const svc = initTaskSuggestionService({ maxSuggestions: 3 });
      expect(getTaskSuggestionService()).toBe(svc);
      expect(svc).toBeInstanceOf(TaskSuggestionService);
    });

    it('should reset global service', () => {
      initTaskSuggestionService();
      expect(getTaskSuggestionService()).not.toBeNull();

      resetTaskSuggestionService();
      expect(getTaskSuggestionService()).toBeNull();
    });
  });
});

describe('isSuggestionAction', () => {
  it('should return true for valid suggestion action', () => {
    const value: SuggestionActionValue = {
      action: 'suggestion',
      prompt: 'test prompt',
      description: 'test description',
    };
    expect(isSuggestionAction(value)).toBe(true);
  });

  it('should return false for non-suggestion action', () => {
    expect(isSuggestionAction({ action: 'other' })).toBe(false);
    expect(isSuggestionAction(null)).toBe(false);
    expect(isSuggestionAction(undefined)).toBe(false);
    expect(isSuggestionAction('string')).toBe(false);
    expect(isSuggestionAction(123)).toBe(false);
  });

  it('should return false for object without prompt', () => {
    expect(isSuggestionAction({ action: 'suggestion' })).toBe(false);
  });
});
