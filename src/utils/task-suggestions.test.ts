import { describe, it, expect } from 'vitest';
import {
  detectTaskType,
  generateSuggestions,
  formatSuggestionsMessage,
  getTaskSuggestions,
  DEFAULT_SUGGESTIONS_CONFIG,
  type TaskContext,
  type Suggestion,
} from './task-suggestions.js';

describe('task-suggestions', () => {
  describe('detectTaskType', () => {
    it('should detect git_operation from commit/push prompts', () => {
      expect(detectTaskType({ originalPrompt: 'commit these changes' })).toBe('git_operation');
      expect(detectTaskType({ originalPrompt: 'create a PR for this branch' })).toBe('git_operation');
      expect(detectTaskType({ originalPrompt: 'push to remote' })).toBe('git_operation');
    });

    it('should detect test_execution from test prompts', () => {
      expect(detectTaskType({ originalPrompt: 'run the tests' })).toBe('test_execution');
      expect(detectTaskType({ originalPrompt: 'run spec files' })).toBe('test_execution');
      expect(detectTaskType({ taskType: 'unknown', testsRun: true })).toBe('test_execution');
    });

    it('should detect documentation from doc prompts', () => {
      expect(detectTaskType({ originalPrompt: 'update the readme' })).toBe('documentation');
      expect(detectTaskType({ originalPrompt: 'write documentation' })).toBe('documentation');
    });

    it('should detect problem_fix from fix prompts', () => {
      expect(detectTaskType({ originalPrompt: 'fix the bug' })).toBe('problem_fix');
      expect(detectTaskType({ originalPrompt: '修复这个问题' })).toBe('problem_fix');
      expect(detectTaskType({ taskType: 'unknown', hadErrors: true })).toBe('problem_fix');
    });

    it('should detect code_modification from create/edit prompts', () => {
      expect(detectTaskType({ originalPrompt: 'create a new file' })).toBe('code_modification');
      expect(detectTaskType({ originalPrompt: 'edit the config' })).toBe('code_modification');
      expect(detectTaskType({ originalPrompt: '修改代码' })).toBe('code_modification');
      expect(detectTaskType({ taskType: 'unknown', hasChanges: true })).toBe('code_modification');
    });

    it('should detect file_analysis from analyze prompts', () => {
      expect(detectTaskType({ originalPrompt: 'analyze the code structure' })).toBe('file_analysis');
      expect(detectTaskType({ originalPrompt: '分析目录结构' })).toBe('file_analysis');
      expect(detectTaskType({ originalPrompt: 'list all files' })).toBe('file_analysis');
    });

    it('should detect info_query from query prompts', () => {
      expect(detectTaskType({ originalPrompt: 'query the database' })).toBe('info_query');
      expect(detectTaskType({ originalPrompt: 'fetch data from API' })).toBe('info_query');
      expect(detectTaskType({ originalPrompt: '获取用户信息' })).toBe('info_query');
    });

    it('should return unknown for unrecognized prompts', () => {
      expect(detectTaskType({ originalPrompt: 'hello world' })).toBe('unknown');
      expect(detectTaskType({})).toBe('unknown');
    });
  });

  describe('generateSuggestions', () => {
    it('should return empty array when disabled', () => {
      const context: TaskContext = { taskType: 'code_modification' };
      const result = generateSuggestions(context, { enabled: false });
      expect(result).toEqual([]);
    });

    it('should return suggestions for known task types', () => {
      const context: TaskContext = { taskType: 'code_modification' };
      const result = generateSuggestions(context);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('emoji');
      expect(result[0]).toHaveProperty('description');
    });

    it('should respect maxSuggestions config', () => {
      const context: TaskContext = { taskType: 'code_modification' };
      const result = generateSuggestions(context, { maxSuggestions: 2 });
      expect(result.length).toBe(2);
    });

    it('should use default maxSuggestions when not specified', () => {
      const context: TaskContext = { taskType: 'code_modification' };
      const result = generateSuggestions(context, { enabled: true });
      expect(result.length).toBe(DEFAULT_SUGGESTIONS_CONFIG.maxSuggestions);
    });

    it('should return suggestions for unknown task type', () => {
      const context: TaskContext = { taskType: 'unknown' };
      const result = generateSuggestions(context);
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('formatSuggestionsMessage', () => {
    it('should return empty string for empty suggestions', () => {
      expect(formatSuggestionsMessage([])).toBe('');
    });

    it('should format suggestions correctly', () => {
      const suggestions: Suggestion[] = [
        { emoji: '🧪', description: 'Run tests' },
        { emoji: '📤', description: 'Commit changes' },
      ];
      const result = formatSuggestionsMessage(suggestions);

      expect(result).toContain('💡');
      expect(result).toContain('接下来你可以');
      expect(result).toContain('1. 🧪 Run tests');
      expect(result).toContain('2. 📤 Commit changes');
    });

    it('should include example prompt when provided', () => {
      const suggestions: Suggestion[] = [
        { emoji: '🧪', description: 'Run tests', examplePrompt: 'npm test' },
      ];
      const result = formatSuggestionsMessage(suggestions);

      expect(result).toContain('`npm test`');
    });
  });

  describe('getTaskSuggestions', () => {
    it('should return formatted message for valid context', () => {
      const context: TaskContext = {
        taskType: 'code_modification',
        originalPrompt: 'create a new feature',
      };
      const result = getTaskSuggestions(context);

      expect(result).toContain('💡');
      expect(result).toContain('接下来你可以');
    });

    it('should return empty string when disabled', () => {
      const context: TaskContext = { taskType: 'code_modification' };
      const result = getTaskSuggestions(context, { enabled: false });

      expect(result).toBe('');
    });
  });
});
