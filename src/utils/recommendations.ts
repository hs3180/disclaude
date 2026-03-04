/**
 * Recommendations Generator - Task completion suggestions.
 *
 * Generates next-step recommendations based on the type of task completed.
 * This provides users with helpful suggestions for follow-up actions.
 *
 * @see Issue #470
 */

import type {
  TaskType,
  RecommendationItem,
  RecommendationsConfig,
} from '../config/types.js';

/**
 * Default recommendations for each task type.
 */
const DEFAULT_RECOMMENDATIONS: Record<TaskType, RecommendationItem[]> = {
  code: [
    { emoji: '🔍', description: '搜索项目中相关代码' },
    { emoji: '📝', description: '添加单元测试' },
    { emoji: '⚡', description: '性能优化' },
    { emoji: '🔧', description: '重构代码结构' },
  ],
  documentation: [
    { emoji: '📚', description: '编写使用文档' },
    { emoji: '📊', description: '生成 API 文档' },
    { emoji: '🎯', description: '更新 README' },
    { emoji: '💡', description: '添加代码注释' },
  ],
  research: [
    { emoji: '🔎', description: '深入调研相关技术' },
    { emoji: '📈', description: '分析最佳实践' },
    { emoji: '🔗', description: '查找参考案例' },
    { emoji: '📋', description: '总结调研结果' },
  ],
  testing: [
    { emoji: '🧪', description: '编写更多测试用例' },
    { emoji: '🚀', description: '运行集成测试' },
    { emoji: '🔍', description: '检查测试覆盖率' },
    { emoji: '✅', description: '验证所有测试通过' },
  ],
  general: [
    { emoji: '📁', description: '查看相关文件' },
    { emoji: '🔍', description: '搜索更多信息' },
    { emoji: '📝', description: '保存结果到文件' },
    { emoji: '💬', description: '继续讨论此话题' },
  ],
};

/**
 * Keywords for task type detection.
 */
const TASK_KEYWORDS: Record<TaskType, string[]> = {
  code: [
    '代码', 'code', '函数', 'function', '类', 'class', '模块', 'module',
    '实现', 'implement', '修复', 'fix', '重构', 'refactor', '优化', 'optimize',
    '变量', 'variable', '接口', 'interface', '类型', 'type',
  ],
  documentation: [
    '文档', 'document', 'doc', 'readme', '说明', 'guide', '指南',
    '注释', 'comment', '描述', 'description', 'api',
  ],
  research: [
    '分析', 'analyze', '调研', 'research', '搜索', 'search', '查找', 'find',
    '了解', 'understand', '研究', 'study', '探索', 'explore',
  ],
  testing: [
    '测试', 'test', '单元测试', 'unit test', '集成测试', 'integration test',
    '覆盖率', 'coverage', '验证', 'verify', '断言', 'assert',
  ],
  general: [],
};

/**
 * Detect task type from user message and agent response.
 *
 * @param userMessage - The user's original message
 * @param agentResponse - The agent's response content
 * @returns Detected task type
 */
export function detectTaskType(
  userMessage: string,
  agentResponse?: string
): TaskType {
  const combinedText = `${userMessage} ${agentResponse ?? ''}`.toLowerCase();

  // Score each task type based on keyword matches
  const scores: Record<TaskType, number> = {
    code: 0,
    documentation: 0,
    research: 0,
    testing: 0,
    general: 0,
  };

  for (const [type, keywords] of Object.entries(TASK_KEYWORDS) as [TaskType, string[]][]) {
    for (const keyword of keywords) {
      if (combinedText.includes(keyword.toLowerCase())) {
        scores[type]++;
      }
    }
  }

  // Find the type with highest score
  let maxScore = 0;
  let detectedType: TaskType = 'general';

  for (const [type, score] of Object.entries(scores) as [TaskType, number][]) {
    if (score > maxScore) {
      maxScore = score;
      detectedType = type;
    }
  }

  return detectedType;
}

/**
 * Get recommendations for a task type.
 *
 * @param taskType - The type of task completed
 * @param config - Optional recommendations configuration
 * @returns Array of recommendation items
 */
export function getRecommendations(
  taskType: TaskType,
  config?: RecommendationsConfig
): RecommendationItem[] {
  const maxRecommendations = config?.maxRecommendations ?? 4;

  // Use custom recommendations if provided, otherwise use defaults
  const recommendations =
    config?.byTaskType?.[taskType] ?? DEFAULT_RECOMMENDATIONS[taskType];

  // Limit to max recommendations
  return recommendations.slice(0, maxRecommendations);
}

/**
 * Format recommendations as a message string.
 *
 * @param recommendations - Array of recommendation items
 * @returns Formatted message string
 */
export function formatRecommendationsMessage(
  recommendations: RecommendationItem[]
): string {
  if (recommendations.length === 0) {
    return '';
  }

  const lines = [
    '',
    '─────────────',
    '💡 接下来你可以：',
    '',
  ];

  recommendations.forEach((rec, index) => {
    lines.push(`${index + 1}. ${rec.emoji} ${rec.description}`);
  });

  return lines.join('\n');
}

/**
 * Generate and format recommendations for a completed task.
 *
 * This is the main entry point for generating task completion recommendations.
 *
 * @param userMessage - The user's original message
 * @param agentResponse - Optional agent response content
 * @param config - Optional recommendations configuration
 * @returns Formatted recommendations message, or empty string if disabled
 */
export function generateRecommendations(
  userMessage: string,
  agentResponse: string | undefined,
  config?: RecommendationsConfig
): string {
  // Check if recommendations are enabled
  if (config?.enabled === false) {
    return '';
  }

  // Detect task type
  const taskType = detectTaskType(userMessage, agentResponse);

  // Get recommendations
  const recommendations = getRecommendations(taskType, config);

  // Format and return
  return formatRecommendationsMessage(recommendations);
}
