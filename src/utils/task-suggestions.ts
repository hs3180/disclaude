/**
 * Task Suggestions - Generate post-task recommendations.
 *
 * This module implements Issue #470: Task completion auto-suggestions.
 * Provides context-aware suggestions for what users might want to do next.
 *
 * @module utils/task-suggestions
 */

import type { SuggestionsConfig } from '../config/types.js';

/**
 * Default suggestions configuration.
 */
export const DEFAULT_SUGGESTIONS_CONFIG: Required<SuggestionsConfig> = {
  enabled: true,
  maxSuggestions: 4,
  showAfterTasks: true,
};

/**
 * A single suggestion item.
 */
export interface Suggestion {
  /** Emoji icon for the suggestion */
  emoji: string;
  /** Description of the suggested action */
  description: string;
  /** Optional example prompt */
  examplePrompt?: string;
}

/**
 * Task type classification for suggestion matching.
 */
export type TaskType =
  | 'file_analysis'      // Analyzing files, directories, code structure
  | 'code_modification'  // Creating, editing, refactoring code
  | 'problem_fix'        // Fixing bugs, errors, issues
  | 'info_query'         // Searching, querying information
  | 'test_execution'     // Running tests
  | 'git_operation'      // Git commits, branches, PRs
  | 'documentation'      // Writing or updating docs
  | 'unknown';           // Default/unknown task type

/**
 * Context information for generating suggestions.
 */
export interface TaskContext {
  /** Type of task that was completed */
  taskType: TaskType;
  /** Files or directories that were operated on */
  targetPaths?: string[];
  /** Whether tests were run */
  testsRun?: boolean;
  /** Whether changes were made */
  hasChanges?: boolean;
  /** Whether there were errors */
  hadErrors?: boolean;
  /** Original user prompt (for context) */
  originalPrompt?: string;
}

/**
 * Suggestion rules by task type.
 */
const SUGGESTION_RULES: Record<TaskType, Suggestion[]> = {
  file_analysis: [
    { emoji: '📝', description: '生成分析文档', examplePrompt: '将分析结果保存为文档' },
    { emoji: '🔍', description: '深入分析特定模块', examplePrompt: '分析 src/utils 目录的依赖关系' },
    { emoji: '📊', description: '统计代码指标', examplePrompt: '统计代码行数和文件分布' },
    { emoji: '🐛', description: '检查代码问题', examplePrompt: '检查代码风格和潜在问题' },
  ],
  code_modification: [
    { emoji: '🧪', description: '运行测试验证', examplePrompt: '运行相关测试' },
    { emoji: '📤', description: '提交更改', examplePrompt: '提交这些修改' },
    { emoji: '🔀', description: '创建 Pull Request', examplePrompt: '创建 PR' },
    { emoji: '📝', description: '更新文档', examplePrompt: '更新 README 文档' },
  ],
  problem_fix: [
    { emoji: '✅', description: '验证修复结果', examplePrompt: '验证问题是否已解决' },
    { emoji: '🧪', description: '添加回归测试', examplePrompt: '为这个修复添加测试' },
    { emoji: '📝', description: '更新变更日志', examplePrompt: '记录这个修复' },
    { emoji: '🔍', description: '检查类似问题', examplePrompt: '查找其他类似的问题' },
  ],
  info_query: [
    { emoji: '📂', description: '保存查询结果', examplePrompt: '将结果保存到文件' },
    { emoji: '🔍', description: '深入分析', examplePrompt: '进一步分析这些信息' },
    { emoji: '📤', description: '分享结果', examplePrompt: '发送结果给相关人员' },
    { emoji: '📊', description: '可视化数据', examplePrompt: '生成图表展示' },
  ],
  test_execution: [
    { emoji: '📊', description: '查看测试覆盖率', examplePrompt: '生成测试覆盖率报告' },
    { emoji: '🔧', description: '修复失败的测试', examplePrompt: '分析并修复失败的测试' },
    { emoji: '📝', description: '更新测试文档', examplePrompt: '更新测试说明' },
    { emoji: '🚀', description: '准备部署', examplePrompt: '检查部署准备情况' },
  ],
  git_operation: [
    { emoji: '👀', description: '查看变更状态', examplePrompt: '查看当前变更' },
    { emoji: '🧪', description: '运行 CI 检查', examplePrompt: '运行测试和检查' },
    { emoji: '📤', description: '推送更改', examplePrompt: '推送到远程仓库' },
    { emoji: '🔔', description: '通知相关人员', examplePrompt: '发送通知' },
  ],
  documentation: [
    { emoji: '👀', description: '预览文档', examplePrompt: '预览渲染效果' },
    { emoji: '📤', description: '提交文档', examplePrompt: '提交文档更新' },
    { emoji: '🔍', description: '检查链接', examplePrompt: '检查文档中的链接' },
    { emoji: '📚', description: '更新目录', examplePrompt: '更新文档目录' },
  ],
  unknown: [
    { emoji: '🔄', description: '继续相关任务', examplePrompt: '继续处理相关内容' },
    { emoji: '📝', description: '记录工作内容', examplePrompt: '记录刚才的操作' },
    { emoji: '🧹', description: '清理临时文件', examplePrompt: '清理工作目录' },
    { emoji: '❓', description: '获取帮助', examplePrompt: '查看可用功能' },
  ],
};

/**
 * Detect task type from context.
 */
export function detectTaskType(context: TaskContext): TaskType {
  const prompt = context.originalPrompt?.toLowerCase() || '';

  // Check for git operations
  if (prompt.includes('commit') || prompt.includes('push') || prompt.includes('pr') ||
      prompt.includes('branch') || prompt.includes('merge')) {
    return 'git_operation';
  }

  // Check for test execution
  if (prompt.includes('test') || prompt.includes('spec') || context.testsRun) {
    return 'test_execution';
  }

  // Check for documentation
  if (prompt.includes('doc') || prompt.includes('readme') || prompt.includes('文档')) {
    return 'documentation';
  }

  // Check for problem fixing
  if (prompt.includes('fix') || prompt.includes('bug') || prompt.includes('error') ||
      prompt.includes('issue') || prompt.includes('修复') || prompt.includes('问题') ||
      context.hadErrors) {
    return 'problem_fix';
  }

  // Check for code modification
  if (prompt.includes('create') || prompt.includes('edit') || prompt.includes('modify') ||
      prompt.includes('refactor') || prompt.includes('update') || prompt.includes('write') ||
      prompt.includes('创建') || prompt.includes('修改') || prompt.includes('编辑') ||
      context.hasChanges) {
    return 'code_modification';
  }

  // Check for file analysis
  if (prompt.includes('analyze') || prompt.includes('list') || prompt.includes('show') ||
      prompt.includes('search') || prompt.includes('find') || prompt.includes('结构') ||
      prompt.includes('分析') || prompt.includes('查找')) {
    return 'file_analysis';
  }

  // Check for info query
  if (prompt.includes('query') || prompt.includes('search') || prompt.includes('get') ||
      prompt.includes('fetch') || prompt.includes('查询') || prompt.includes('获取')) {
    return 'info_query';
  }

  return context.taskType || 'unknown';
}

/**
 * Generate suggestions based on task context.
 */
export function generateSuggestions(
  context: TaskContext,
  config: SuggestionsConfig = DEFAULT_SUGGESTIONS_CONFIG
): Suggestion[] {
  if (config.enabled === false) {
    return [];
  }

  const taskType = detectTaskType(context);
  const baseSuggestions = SUGGESTION_RULES[taskType] || SUGGESTION_RULES.unknown;
  const maxSuggestions = config.maxSuggestions ?? DEFAULT_SUGGESTIONS_CONFIG.maxSuggestions;

  return baseSuggestions.slice(0, maxSuggestions);
}

/**
 * Format suggestions as a message string.
 */
export function formatSuggestionsMessage(suggestions: Suggestion[]): string {
  if (suggestions.length === 0) {
    return '';
  }

  const lines = [
    '─────────────',
    '💡 **接下来你可以：**',
    '',
  ];

  suggestions.forEach((suggestion, index) => {
    const example = suggestion.examplePrompt
      ? ` \`${suggestion.examplePrompt}\``
      : '';
    lines.push(`${index + 1}. ${suggestion.emoji} ${suggestion.description}${example}`);
  });

  return lines.join('\n');
}

/**
 * Main function to generate and format suggestions.
 */
export function getTaskSuggestions(
  context: TaskContext,
  config: SuggestionsConfig = DEFAULT_SUGGESTIONS_CONFIG
): string {
  const suggestions = generateSuggestions(context, config);
  return formatSuggestionsMessage(suggestions);
}
