/**
 * Task Suggestion Service - Generate follow-up suggestions after task completion.
 *
 * This service provides intelligent suggestions for what the user might want to do next
 * after completing a task, based on the task type and context.
 *
 * Issue #470: Task completion follow-up suggestions
 *
 * @example
 * ```typescript
 * const suggestionService = new TaskSuggestionService({
 *   enabled: true,
 *   maxSuggestions: 4,
 * });
 *
 * const suggestions = suggestionService.generateSuggestions({
 *   taskType: 'file-analysis',
 *   context: 'Analyzed src directory structure',
 * });
 *
 * // Returns:
 * // "─────────────\n💡 接下来你可以：\n\n1. 📝 生成代码结构文档\n..."
 * ```
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskSuggestion');

/**
 * Configuration for task suggestions.
 */
export interface TaskSuggestionConfig {
  /** Enable/disable suggestion feature */
  enabled?: boolean;
  /** Maximum number of suggestions to show */
  maxSuggestions?: number;
  /** Show suggestions after all tasks (default: true) */
  showAfterTasks?: boolean;
}

/**
 * Task type categories for suggestion matching.
 */
export type TaskType =
  | 'file-analysis'
  | 'code-modification'
  | 'bug-fix'
  | 'information-query'
  | 'file-operation'
  | 'test-execution'
  | 'documentation'
  | 'general';

/**
 * Context for generating suggestions.
 */
export interface SuggestionContext {
  /** Type of task that was completed */
  taskType: TaskType;
  /** Brief description of what was done */
  context?: string;
  /** Files or directories involved */
  targets?: string[];
  /** Whether the task was successful */
  success?: boolean;
}

/**
 * A single suggestion item.
 */
export interface Suggestion {
  /** Emoji icon for the suggestion */
  emoji: string;
  /** Description of the action */
  description: string;
  /** Example prompt the user could send */
  examplePrompt?: string;
}

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: Required<TaskSuggestionConfig> = {
  enabled: true,
  maxSuggestions: 4,
  showAfterTasks: true,
};

/**
 * Suggestion rules by task type.
 * Each rule defines suggestions relevant to that task type.
 */
const SUGGESTION_RULES: Record<TaskType, Suggestion[]> = {
  'file-analysis': [
    { emoji: '📝', description: '生成代码结构文档', examplePrompt: '为这个目录生成 README 文档' },
    { emoji: '🔍', description: '分析模块依赖关系', examplePrompt: '分析这些文件的依赖关系' },
    { emoji: '📊', description: '统计代码行数和文件分布', examplePrompt: '统计代码行数' },
    { emoji: '🐛', description: '检查代码风格问题', examplePrompt: '检查代码风格问题' },
  ],
  'code-modification': [
    { emoji: '🧪', description: '运行测试验证修改', examplePrompt: '运行相关测试' },
    { emoji: '📝', description: '提交更改', examplePrompt: '提交这些更改' },
    { emoji: '🔀', description: '创建 Pull Request', examplePrompt: '创建 PR' },
    { emoji: '📋', description: '更新相关文档', examplePrompt: '更新文档' },
  ],
  'bug-fix': [
    { emoji: '✅', description: '验证修复是否生效', examplePrompt: '验证修复' },
    { emoji: '🧪', description: '添加回归测试', examplePrompt: '为这个修复添加测试' },
    { emoji: '📝', description: '更新 CHANGELOG', examplePrompt: '更新 CHANGELOG' },
    { emoji: '📋', description: '更新相关文档', examplePrompt: '更新文档' },
  ],
  'information-query': [
    { emoji: '🔍', description: '深入分析相关信息', examplePrompt: '深入分析' },
    { emoji: '💾', description: '保存查询结果', examplePrompt: '保存结果到文件' },
    { emoji: '📤', description: '分享给他人', examplePrompt: '生成分享报告' },
    { emoji: '📊', description: '生成可视化报告', examplePrompt: '生成报告' },
  ],
  'file-operation': [
    { emoji: '🔍', description: '查看文件内容', examplePrompt: '查看文件内容' },
    { emoji: '📝', description: '编辑文件', examplePrompt: '编辑文件' },
    { emoji: '📋', description: '比较文件差异', examplePrompt: '比较文件' },
    { emoji: '🗂️', description: '整理文件结构', examplePrompt: '整理文件' },
  ],
  'test-execution': [
    { emoji: '📋', description: '查看测试报告', examplePrompt: '查看测试报告详情' },
    { emoji: '🐛', description: '分析失败的测试', examplePrompt: '分析失败的测试' },
    { emoji: '🔧', description: '修复测试问题', examplePrompt: '修复测试' },
    { emoji: '🧪', description: '运行更多测试', examplePrompt: '运行全部测试' },
  ],
  documentation: [
    { emoji: '📤', description: '发布文档', examplePrompt: '发布文档' },
    { emoji: '🔍', description: '检查文档完整性', examplePrompt: '检查文档' },
    { emoji: '📝', description: '更新相关文档', examplePrompt: '更新相关文档' },
    { emoji: '🌐', description: '翻译文档', examplePrompt: '翻译文档' },
  ],
  general: [
    { emoji: '🔄', description: '继续相关任务', examplePrompt: '继续' },
    { emoji: '❓', description: '询问更多细节', examplePrompt: '请告诉我更多' },
    { emoji: '📋', description: '查看历史记录', examplePrompt: '查看历史' },
    { emoji: '🗑️', description: '清理工作区', examplePrompt: '清理临时文件' },
  ],
};

/**
 * Keywords for detecting task types from message content.
 */
const TASK_TYPE_KEYWORDS: Record<TaskType, string[]> = {
  'file-analysis': ['分析', '结构', '目录', '代码结构', 'analyze', 'structure', 'directory'],
  'code-modification': ['修改', '更新', '重构', 'modify', 'update', 'refactor', 'edit'],
  'bug-fix': ['修复', 'fix', 'bug', '问题', 'error', '解决'],
  'information-query': ['查询', '搜索', '查找', 'query', 'search', 'find', '获取'],
  'file-operation': ['创建', '删除', '移动', '复制', 'create', 'delete', 'move', 'copy'],
  'test-execution': ['测试', 'test', 'spec', 'vitest', 'jest'],
  documentation: ['文档', 'document', 'readme', 'md', '说明'],
  general: [],
};

/**
 * Task Suggestion Service - Generates follow-up suggestions after task completion.
 */
export class TaskSuggestionService {
  private readonly config: Required<TaskSuggestionConfig>;

  constructor(config?: TaskSuggestionConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.info({ config: this.config }, 'TaskSuggestionService initialized');
  }

  /**
   * Check if suggestions are enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled && this.config.showAfterTasks;
  }

  /**
   * Detect task type from message content.
   *
   * @param content - The result message content
   * @returns Detected task type
   */
  detectTaskType(content: string): TaskType {
    const lowerContent = content.toLowerCase();

    // Check each task type's keywords
    for (const [type, keywords] of Object.entries(TASK_TYPE_KEYWORDS)) {
      if (type === 'general') continue; // Skip general, it's the fallback

      for (const keyword of keywords) {
        if (lowerContent.includes(keyword.toLowerCase())) {
          return type as TaskType;
        }
      }
    }

    return 'general';
  }

  /**
   * Generate suggestions based on task completion context.
   *
   * @param context - Context about the completed task
   * @returns Formatted suggestion string, or empty string if disabled
   */
  generateSuggestions(context: SuggestionContext): string {
    if (!this.config.enabled) {
      return '';
    }

    const suggestions = SUGGESTION_RULES[context.taskType] || SUGGESTION_RULES.general;
    const limitedSuggestions = suggestions.slice(0, this.config.maxSuggestions);

    if (limitedSuggestions.length === 0) {
      return '';
    }

    const suggestionLines = limitedSuggestions
      .map((s, index) => {
        if (s.examplePrompt) {
          return `${index + 1}. ${s.emoji} ${s.description}\n   \`${s.examplePrompt}\``;
        }
        return `${index + 1}. ${s.emoji} ${s.description}`;
      })
      .join('\n');

    const result = `─────────────
💡 接下来你可以：

${suggestionLines}`;

    logger.debug({ taskType: context.taskType, suggestionCount: limitedSuggestions.length }, 'Generated suggestions');

    return result;
  }

  /**
   * Generate suggestions from result content (auto-detect task type).
   *
   * @param resultContent - The result message content
   * @returns Formatted suggestion string, or empty string if disabled
   */
  generateFromResult(resultContent: string): string {
    if (!this.config.enabled) {
      return '';
    }

    const taskType = this.detectTaskType(resultContent);
    return this.generateSuggestions({ taskType, context: resultContent });
  }
}

// ============================================================================
// Global Instance Management
// ============================================================================

let globalTaskSuggestionService: TaskSuggestionService | null = null;

/**
 * Initialize the global task suggestion service.
 */
export function initTaskSuggestionService(config?: TaskSuggestionConfig): TaskSuggestionService {
  globalTaskSuggestionService = new TaskSuggestionService(config);
  logger.info('Global TaskSuggestionService initialized');
  return globalTaskSuggestionService;
}

/**
 * Get the global task suggestion service.
 * Returns null if not initialized (suggestions disabled).
 */
export function getTaskSuggestionService(): TaskSuggestionService | null {
  return globalTaskSuggestionService;
}

/**
 * Reset the global task suggestion service (for testing).
 */
export function resetTaskSuggestionService(): void {
  globalTaskSuggestionService = null;
}
