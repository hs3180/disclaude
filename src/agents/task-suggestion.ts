/**
 * Task Suggestion Service - Generates interactive suggestion cards after task completion.
 *
 * Issue #470: Task completion follow-up suggestions
 *
 * Instead of text suggestions, this service generates interactive cards with buttons.
 * When a user clicks a button, the associated prompt is sent to the Agent for execution.
 */

import { createLogger } from '../utils/logger.js';
import {
  buildCard,
  buildDiv,
  buildDivider,
  buildActionGroup,
  buildButton,
  type BuiltCard,
  type ButtonAction,
} from '../platforms/feishu/card-builders/interactive-card-builder.js';

const logger = createLogger('TaskSuggestion');

/**
 * Task types that can be detected from result content.
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
 * A single suggestion with prompt to execute.
 */
export interface Suggestion {
  /** Emoji icon for the suggestion */
  emoji: string;
  /** Short description */
  description: string;
  /** Prompt to send to Agent when clicked */
  prompt: string;
}

/**
 * Task suggestion configuration.
 */
export interface TaskSuggestionConfig {
  /** Enable/disable suggestion feature */
  enabled?: boolean;
  /** Maximum number of suggestions to show (default: 4) */
  maxSuggestions?: number;
  /** Show suggestions after all tasks (default: true) */
  showAfterTasks?: boolean;
}

/**
 * Context for generating suggestions.
 */
export interface SuggestionContext {
  /** Detected task type */
  taskType: TaskType;
  /** Original result content (for context-aware suggestions) */
  context?: string;
}

/**
 * Keywords for detecting task types.
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
 * Suggestion rules per task type.
 * Each suggestion includes an emoji, description, and the prompt to execute.
 */
const SUGGESTION_RULES: Record<TaskType, Suggestion[]> = {
  'file-analysis': [
    { emoji: '📝', description: '生成代码结构文档', prompt: '请为刚才分析的代码结构生成一份文档' },
    { emoji: '🔍', description: '分析依赖关系', prompt: '请分析这些文件的依赖关系' },
    { emoji: '📊', description: '统计代码行数', prompt: '请统计刚才分析的代码的行数和文件分布' },
    { emoji: '🐛', description: '检查代码问题', prompt: '请检查刚才分析的代码是否存在潜在问题' },
  ],
  'code-modification': [
    { emoji: '🧪', description: '运行测试验证', prompt: '请运行相关测试来验证修改' },
    { emoji: '📝', description: '提交更改', prompt: '请帮我提交这些更改' },
    { emoji: '📄', description: '更新文档', prompt: '请更新相关文档以反映这些修改' },
    { emoji: '🔍', description: '检查影响范围', prompt: '请分析这些修改可能影响的其他代码' },
  ],
  'bug-fix': [
    { emoji: '✅', description: '验证修复', prompt: '请验证这个修复是否解决了问题' },
    { emoji: '🧪', description: '添加测试用例', prompt: '请为这个修复添加测试用例以防止回归' },
    { emoji: '📄', description: '更新变更日志', prompt: '请更新变更日志记录这个修复' },
    { emoji: '🔍', description: '检查类似问题', prompt: '请检查代码中是否存在类似的问题' },
  ],
  'information-query': [
    { emoji: '💾', description: '保存结果', prompt: '请将查询结果保存到文件' },
    { emoji: '📊', description: '生成报告', prompt: '请根据查询结果生成一份报告' },
    { emoji: '📤', description: '分享结果', prompt: '请帮我分享这些查询结果' },
    { emoji: '🔍', description: '深入分析', prompt: '请对查询结果进行更深入的分析' },
  ],
  'file-operation': [
    { emoji: '✅', description: '验证操作', prompt: '请验证文件操作是否成功完成' },
    { emoji: '📝', description: '更新相关引用', prompt: '请检查并更新相关的文件引用' },
    { emoji: '🧪', description: '运行测试', prompt: '请运行测试确保操作没有破坏其他功能' },
    { emoji: '📄', description: '提交更改', prompt: '请帮我提交这些文件操作' },
  ],
  'test-execution': [
    { emoji: '🐛', description: '分析失败用例', prompt: '请分析失败的测试用例' },
    { emoji: '📊', description: '生成测试报告', prompt: '请生成测试结果报告' },
    { emoji: '🔧', description: '修复失败测试', prompt: '请帮我修复失败的测试' },
    { emoji: '🚀', description: '运行全部测试', prompt: '请运行完整的测试套件' },
  ],
  documentation: [
    { emoji: '📤', description: '发布文档', prompt: '请帮我发布这份文档' },
    { emoji: '🔍', description: '检查完整性', prompt: '请检查文档是否完整' },
    { emoji: '🌐', description: '翻译文档', prompt: '请将文档翻译成英文' },
    { emoji: '✏️', description: '改进文档', prompt: '请改进文档的可读性' },
  ],
  general: [
    { emoji: '🔄', description: '继续执行', prompt: '请继续执行' },
    { emoji: '📝', description: '总结结果', prompt: '请总结刚才的操作结果' },
    { emoji: '💾', description: '保存结果', prompt: '请保存操作结果' },
    { emoji: '❓', description: '提供帮助', prompt: '请告诉我接下来可以做什么' },
  ],
};

/**
 * Action value for suggestion button clicks.
 * This is serialized as JSON in the button's value field.
 */
export interface SuggestionActionValue {
  /** Action type: 'suggestion' */
  action: 'suggestion';
  /** The prompt to send to the Agent */
  prompt: string;
  /** The description of the suggestion (for logging) */
  description: string;
}

/**
 * Task Suggestion Service - Generates follow-up suggestions after task completion.
 *
 * This service:
 * 1. Detects task type from result content
 * 2. Generates an interactive card with suggestion buttons
 * 3. Each button contains a prompt that will be sent to the Agent when clicked
 */
export class TaskSuggestionService {
  private readonly config: Required<TaskSuggestionConfig>;

  constructor(config?: TaskSuggestionConfig) {
    this.config = {
      enabled: config?.enabled ?? true,
      maxSuggestions: config?.maxSuggestions ?? 4,
      showAfterTasks: config?.showAfterTasks ?? true,
    };
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
      if (type === 'general') {
        continue; // Skip general, it's the fallback
      }

      for (const keyword of keywords) {
        if (lowerContent.includes(keyword.toLowerCase())) {
          return type as TaskType;
        }
      }
    }

    return 'general';
  }

  /**
   * Build suggestion buttons for a card.
   *
   * @param suggestions - Suggestions to build buttons for
   * @returns Array of button actions
   */
  private buildSuggestionButtons(suggestions: Suggestion[]): ButtonAction[] {
    return suggestions.map((s) => {
      const actionValue: SuggestionActionValue = {
        action: 'suggestion',
        prompt: s.prompt,
        description: s.description,
      };

      // Build button directly to control the value format
      // The value needs to be a JSON string for the interaction handler to parse
      const button: ButtonAction = {
        tag: 'button',
        text: { tag: 'plain_text', content: `${s.emoji} ${s.description}` },
        type: 'default',
        value: JSON.stringify(actionValue),
      };

      return button;
    });
  }

  /**
   * Generate an interactive suggestion card based on task completion context.
   *
   * @param context - Context about the completed task
   * @returns Built card object, or null if disabled
   */
  generateSuggestionCard(context: SuggestionContext): BuiltCard | null {
    if (!this.config.enabled) {
      return null;
    }

    const suggestions = SUGGESTION_RULES[context.taskType] || SUGGESTION_RULES.general;
    const limitedSuggestions = suggestions.slice(0, this.config.maxSuggestions);

    if (limitedSuggestions.length === 0) {
      return null;
    }

    // Build buttons in groups of 2 (for better layout)
    const buttons = this.buildSuggestionButtons(limitedSuggestions);

    // Create card with title, divider, and action buttons
    const card = buildCard({
      header: {
        title: '💡 接下来你可以',
        template: 'blue',
      },
      elements: [
        buildDivider(),
        // Add buttons as action groups (2 per row for better mobile experience)
        ...this.groupButtons(buttons),
      ],
    });

    logger.debug(
      { taskType: context.taskType, suggestionCount: limitedSuggestions.length },
      'Generated suggestion card'
    );

    return card;
  }

  /**
   * Group buttons into action groups (2 per row).
   *
   * @param buttons - Buttons to group
   * @returns Array of action group elements
   */
  private groupButtons(buttons: ButtonAction[]): ReturnType<typeof buildActionGroup>[] {
    const groups: ReturnType<typeof buildActionGroup>[] = [];

    for (let i = 0; i < buttons.length; i += 2) {
      const rowButtons = buttons.slice(i, i + 2);
      groups.push(buildActionGroup(rowButtons));
    }

    return groups;
  }

  /**
   * Generate suggestions from result content (auto-detect task type).
   *
   * @param resultContent - The result message content
   * @returns Built card object, or null if disabled
   */
  generateFromResult(resultContent: string): BuiltCard | null {
    if (!this.config.enabled) {
      return null;
    }

    const taskType = this.detectTaskType(resultContent);
    return this.generateSuggestionCard({ taskType, context: resultContent });
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

/**
 * Check if an action value is a suggestion action.
 */
export function isSuggestionAction(value: unknown): value is SuggestionActionValue {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return v.action === 'suggestion' && typeof v.prompt === 'string';
}
