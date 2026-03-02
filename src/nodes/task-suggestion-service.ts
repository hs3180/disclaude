/**
 * TaskSuggestionService - Generate next-step suggestions after task completion.
 *
 * This service analyzes the last user message and task result to provide
 * relevant follow-up suggestions, helping users discover what they can do next.
 *
 * Issue #470: feat: 任务完成后自动推荐下一步操作
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskSuggestionService');

/**
 * Task type classification for suggestion matching.
 */
export type TaskType =
  | 'file_analysis'    // File/directory analysis
  | 'code_modification' // Code changes
  | 'bug_fix'          // Bug fixes
  | 'info_query'       // Information queries
  | 'general';         // Default/fallback

/**
 * A single suggestion item.
 */
export interface SuggestionItem {
  /** Emoji icon for visual distinction */
  emoji: string;
  /** Description of the suggested action */
  description: string;
  /** Example prompt the user can send */
  examplePrompt?: string;
}

/**
 * Configuration for TaskSuggestionService.
 */
export interface TaskSuggestionConfig {
  /** Enable/disable suggestions */
  enabled: boolean;
  /** Maximum number of suggestions to show */
  maxSuggestions: number;
  /** Show suggestions after task completion */
  showAfterTasks: boolean;
}

/**
 * Default configuration values.
 */
export const DEFAULT_TASK_SUGGESTION_CONFIG: TaskSuggestionConfig = {
  enabled: true,
  maxSuggestions: 4,
  showAfterTasks: true,
};

/**
 * Keywords for task type detection.
 * Note: Keywords are ordered by specificity - more specific keywords should be checked first.
 */
const TASK_TYPE_KEYWORDS: Record<TaskType, string[]> = {
  // Most specific: bug fixing
  bug_fix: [
    '修复', 'fix', 'bug', '错误', 'error', '问题', 'issue', '解决', 'resolve',
    '调试', 'debug', '异常', 'exception', '崩溃', 'crash',
  ],
  // Code modification keywords (should be checked before file_analysis)
  code_modification: [
    '修改', 'modify', '更新', 'update', '添加', 'add', '删除', 'delete',
    '重构', 'refactor', '优化', 'optimize', '实现', 'implement',
    '创建', 'create', '编写', 'write', '编辑', 'edit',
  ],
  // Info query keywords (should be checked before file_analysis)
  info_query: [
    '查询', 'query', '搜索', 'search', '什么是', 'what is',
    '如何', 'how to', '解释', 'explain', '说明', 'describe',
  ],
  // File analysis (most general, checked last)
  file_analysis: [
    '分析', 'analyze', '结构', 'structure', '目录', 'directory',
    '统计', 'statistics', '依赖', 'dependency',
    '读取', 'read', '查看', 'view', '检查', 'check',
  ],
  general: [],
};

/**
 * Suggestions for each task type.
 */
const TASK_SUGGESTIONS: Record<TaskType, SuggestionItem[]> = {
  file_analysis: [
    { emoji: '📝', description: '生成文档', examplePrompt: '为这个模块生成 README 文档' },
    { emoji: '🔍', description: '分析依赖关系', examplePrompt: '分析这个模块的依赖关系' },
    { emoji: '📊', description: '统计代码行数', examplePrompt: '统计代码行数和文件分布' },
    { emoji: '🐛', description: '检查代码问题', examplePrompt: '检查代码风格和潜在问题' },
    { emoji: '🔧', description: '优化建议', examplePrompt: '给出代码优化建议' },
  ],
  code_modification: [
    { emoji: '🧪', description: '运行测试', examplePrompt: '运行相关测试' },
    { emoji: '📤', description: '提交更改', examplePrompt: '帮我提交这些更改' },
    { emoji: '📋', description: '创建 PR', examplePrompt: '为这些更改创建 Pull Request' },
    { emoji: '📝', description: '更新文档', examplePrompt: '更新相关文档' },
    { emoji: '🔍', description: '代码审查', examplePrompt: '审查这些更改' },
  ],
  bug_fix: [
    { emoji: '✅', description: '验证修复', examplePrompt: '验证这个修复是否生效' },
    { emoji: '🧪', description: '添加测试', examplePrompt: '为这个修复添加测试用例' },
    { emoji: '📝', description: '更新文档', examplePrompt: '更新相关文档说明' },
    { emoji: '🔍', description: '检查类似问题', examplePrompt: '检查是否有类似的问题' },
  ],
  info_query: [
    { emoji: '📂', description: '深入分析', examplePrompt: '深入分析这个内容' },
    { emoji: '💾', description: '保存结果', examplePrompt: '保存这个结果到文件' },
    { emoji: '📤', description: '分享结果', examplePrompt: '格式化结果以便分享' },
    { emoji: '🔍', description: '继续探索', examplePrompt: '继续探索相关内容' },
  ],
  general: [
    { emoji: '🔄', description: '继续工作', examplePrompt: '继续' },
    { emoji: '❓', description: '获取帮助', examplePrompt: '你能做什么' },
    { emoji: '📝', description: '查看历史', examplePrompt: '查看最近的工作' },
    { emoji: '🧹', description: '清理工作区', examplePrompt: '清理临时文件' },
  ],
};

/**
 * TaskSuggestionService - Generates next-step suggestions after task completion.
 *
 * Uses a rule-based approach to classify tasks and provide relevant suggestions.
 * Can be upgraded to LLM-based generation in the future.
 */
export class TaskSuggestionService {
  private readonly config: TaskSuggestionConfig;

  constructor(config: Partial<TaskSuggestionConfig> = {}) {
    this.config = { ...DEFAULT_TASK_SUGGESTION_CONFIG, ...config };
    logger.info({ config: this.config }, 'TaskSuggestionService initialized');
  }

  /**
   * Check if suggestions are enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled && this.config.showAfterTasks;
  }

  /**
   * Generate suggestions based on the last user message and task result.
   *
   * @param lastUserMessage - The last message from the user
   * @param _taskResult - The result of the task (unused in rule-based approach)
   * @returns Array of suggestion items
   */
  generateSuggestions(lastUserMessage: string, _taskResult?: string): SuggestionItem[] {
    if (!this.config.enabled) {
      return [];
    }

    // Detect task type
    const taskType = this.detectTaskType(lastUserMessage);
    logger.debug({ taskType, message: lastUserMessage.slice(0, 100) }, 'Detected task type');

    // Get suggestions for this task type
    const allSuggestions = TASK_SUGGESTIONS[taskType];

    // Limit to maxSuggestions
    const suggestions = allSuggestions.slice(0, this.config.maxSuggestions);

    logger.info({ taskType, suggestionCount: suggestions.length }, 'Generated suggestions');
    return suggestions;
  }

  /**
   * Format suggestions as a message string.
   *
   * @param suggestions - Array of suggestion items
   * @returns Formatted message string
   */
  formatSuggestionsMessage(suggestions: SuggestionItem[]): string {
    if (suggestions.length === 0) {
      return '';
    }

    const lines = ['─────────────', '💡 **接下来你可以：**', ''];

    suggestions.forEach((suggestion, index) => {
      const promptHint = suggestion.examplePrompt
        ? ` \`${suggestion.examplePrompt}\``
        : '';
      lines.push(`${index + 1}. ${suggestion.emoji} ${suggestion.description}${promptHint}`);
    });

    return lines.join('\n');
  }

  /**
   * Generate and format suggestions as a complete message.
   *
   * @param lastUserMessage - The last message from the user
   * @param taskResult - The result of the task
   * @returns Formatted suggestions message, or empty string if disabled
   */
  generateSuggestionsMessage(lastUserMessage: string, taskResult?: string): string {
    const suggestions = this.generateSuggestions(lastUserMessage, taskResult);
    return this.formatSuggestionsMessage(suggestions);
  }

  /**
   * Detect the task type from the user message.
   *
   * Uses priority-based matching: more specific types are checked first.
   * - bug_fix: Most specific (fixing issues)
   * - code_modification: Changing code
   * - info_query: Asking questions
   * - file_analysis: Most general (analyzing files)
   *
   * @param message - The user message to analyze
   * @returns Detected task type
   */
  private detectTaskType(message: string): TaskType {
    const lowerMessage = message.toLowerCase();

    // Check types in priority order (most specific first)
    const priorityOrder: TaskType[] = ['bug_fix', 'code_modification', 'info_query', 'file_analysis'];

    for (const type of priorityOrder) {
      const keywords = TASK_TYPE_KEYWORDS[type];
      for (const keyword of keywords) {
        if (lowerMessage.includes(keyword.toLowerCase())) {
          return type;
        }
      }
    }

    // If no keywords matched, use general
    return 'general';
  }

  /**
   * Update configuration.
   *
   * @param config - Partial configuration to update
   */
  updateConfig(config: Partial<TaskSuggestionConfig>): void {
    Object.assign(this.config, config);
    logger.info({ config: this.config }, 'TaskSuggestionService config updated');
  }

  /**
   * Get current configuration.
   *
   * @returns Current configuration
   */
  getConfig(): TaskSuggestionConfig {
    return { ...this.config };
  }
}
