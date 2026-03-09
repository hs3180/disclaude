/**
 * Task Summary Service - Generates periodic summaries of task execution history.
 *
 * Issue #1234: Task ETA Prediction System
 *
 * Provides:
 * - Task type statistics summary
 * - Time estimation accuracy analysis
 * - Improvement recommendations
 *
 * @module agents/task-summary-service
 */

import { createLogger } from '../utils/logger.js';
import { taskHistoryStorage, type TaskRecord, type TaskTypeStats } from './task-history.js';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';

const logger = createLogger('TaskSummaryService');

/**
 * Summary report for a task type.
 */
export interface TaskTypeSummary {
  /** Task type name */
  taskType: string;
  /** Number of tasks analyzed */
  taskCount: number;
  /** Average duration in seconds */
  avgDuration: number;
  /** Min duration */
  minDuration: number;
  /** Max duration */
  maxDuration: number;
  /** Estimation accuracy (0-1) */
  estimationAccuracy: number;
  /** Common issues or patterns */
  patterns: string[];
  /** Recommendations */
  recommendations: string[];
}

/**
 * Full summary report.
 */
export interface SummaryReport {
  /** Report generation timestamp */
  generatedAt: string;
  /** Total tasks analyzed */
  totalTasks: number;
  /** Date range of analyzed tasks */
  dateRange: {
    from: string;
    to: string;
  };
  /** Per-task-type summaries */
  taskTypeSummaries: TaskTypeSummary[];
  /** Overall recommendations */
  overallRecommendations: string[];
  /** Key insights */
  insights: string[];
}

/**
 * Configuration for TaskSummaryService.
 */
export interface TaskSummaryServiceConfig {
  /** Directory to store summary reports */
  reportsDir: string;
  /** Minimum tasks for a task type to be included in report */
  minTasksForReport: number;
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: TaskSummaryServiceConfig = {
  reportsDir: 'data/task-summaries',
  minTasksForReport: 3,
};

/**
 * Task Summary Service.
 *
 * Analyzes historical task data and generates summary reports.
 *
 * @example
 * ```typescript
 * const service = new TaskSummaryService();
 *
 * // Generate a summary report
 * const report = await service.generateSummary();
 *
 * // Get recommendations for a task type
 * const recommendations = await service.getRecommendations('refactoring');
 * ```
 */
export class TaskSummaryService {
  private readonly config: TaskSummaryServiceConfig;

  constructor(config: Partial<TaskSummaryServiceConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Generate a comprehensive summary report.
   */
  async generateSummary(): Promise<SummaryReport> {
    logger.info('Generating task summary report');

    try {
      // Get all reliable task types
      const taskTypes = await taskHistoryStorage.getReliableTaskTypes();

      // Get storage stats
      const stats = taskHistoryStorage.getStats();

      // Analyze each task type
      const taskTypeSummaries: TaskTypeSummary[] = [];

      for (const taskType of taskTypes) {
        const summary = await this.analyzeTaskType(taskType);
        if (summary) {
          taskTypeSummaries.push(summary);
        }
      }

      // Generate overall insights and recommendations
      const insights = this.generateInsights(taskTypeSummaries);
      const overallRecommendations = this.generateOverallRecommendations(taskTypeSummaries);

      // Calculate date range
      const dateRange = await this.getDateRange();

      const report: SummaryReport = {
        generatedAt: new Date().toISOString(),
        totalTasks: stats.historyCount,
        dateRange,
        taskTypeSummaries,
        overallRecommendations,
        insights,
      };

      // Save report
      await this.saveReport(report);

      logger.info({
        totalTasks: stats.historyCount,
        taskTypes: taskTypeSummaries.length,
      }, 'Summary report generated');

      return report;

    } catch (error) {
      logger.error({ err: error }, 'Failed to generate summary report');
      throw error;
    }
  }

  /**
   * Analyze a specific task type.
   */
  private async analyzeTaskType(taskType: string): Promise<TaskTypeSummary | null> {
    try {
      const tasks = await taskHistoryStorage.getSimilarTasks(taskType, 100);
      const typeStats = await taskHistoryStorage.getTaskTypeStats(taskType);

      if (tasks.length < this.config.minTasksForReport) {
        return null;
      }

      // Calculate statistics
      const durations = tasks.map(t => t.actualSeconds);
      const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
      const minDuration = Math.min(...durations);
      const maxDuration = Math.max(...durations);

      // Calculate estimation accuracy
      const estimationAccuracy = typeStats
        ? 1 - Math.abs(1 - typeStats.avgErrorRatio)
        : 0;

      // Identify patterns
      const patterns = this.identifyPatterns(tasks);

      // Generate recommendations
      const recommendations = this.generateRecommendations(
        taskType,
        avgDuration,
        estimationAccuracy,
        patterns
      );

      return {
        taskType,
        taskCount: tasks.length,
        avgDuration: Math.round(avgDuration),
        minDuration: Math.round(minDuration),
        maxDuration: Math.round(maxDuration),
        estimationAccuracy: Math.round(estimationAccuracy * 100) / 100,
        patterns,
        recommendations,
      };

    } catch (error) {
      logger.error({ err: error, taskType }, 'Failed to analyze task type');
      return null;
    }
  }

  /**
   * Identify common patterns in tasks.
   */
  private identifyPatterns(tasks: TaskRecord[]): string[] {
    const patterns: string[] = [];

    // Check for overestimation
    const overestimated = tasks.filter(t => t.estimatedSeconds > t.actualSeconds * 1.5);
    if (overestimated.length > tasks.length * 0.5) {
      patterns.push('普遍高估时间');
    }

    // Check for underestimation
    const underestimated = tasks.filter(t => t.estimatedSeconds < t.actualSeconds * 0.5);
    if (underestimated.length > tasks.length * 0.5) {
      patterns.push('普遍低估时间');
    }

    // Check for high variance
    const durations = tasks.map(t => t.actualSeconds);
    const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
    const variance = durations.reduce((sum, d) => sum + Math.pow(d - avgDuration, 2), 0) / durations.length;
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation = stdDev / avgDuration;

    if (coefficientOfVariation > 0.5) {
      patterns.push('任务时间变化大，难以预测');
    } else if (coefficientOfVariation < 0.2) {
      patterns.push('任务时间稳定，容易预测');
    }

    // Check success rate
    const successRate = tasks.filter(t => t.success).length / tasks.length;
    if (successRate < 0.8) {
      patterns.push(`成功率较低 (${Math.round(successRate * 100)}%)`);
    } else if (successRate >= 0.95) {
      patterns.push('成功率很高');
    }

    return patterns;
  }

  /**
   * Generate recommendations for a task type.
   */
  private generateRecommendations(
    taskType: string,
    avgDuration: number,
    estimationAccuracy: number,
    patterns: string[]
  ): string[] {
    const recommendations: string[] = [];

    // Based on estimation accuracy
    if (estimationAccuracy < 0.5) {
      recommendations.push('考虑收集更多样本以提高预测准确性');
    }

    // Based on patterns
    if (patterns.includes('普遍高估时间')) {
      recommendations.push('可以适当缩短预估时间');
    }
    if (patterns.includes('普遍低估时间')) {
      recommendations.push('建议增加缓冲时间');
    }
    if (patterns.includes('任务时间变化大，难以预测')) {
      recommendations.push('任务复杂度差异较大，建议分类处理');
    }

    // Based on average duration
    if (avgDuration > 600) { // 10 minutes
      recommendations.push('此类任务较复杂，建议分解为多个子任务');
    }

    // Default recommendation if none specific
    if (recommendations.length === 0) {
      recommendations.push('继续收集数据以优化预测');
    }

    return recommendations;
  }

  /**
   * Generate overall insights from task summaries.
   */
  private generateInsights(summaries: TaskTypeSummary[]): string[] {
    const insights: string[] = [];

    if (summaries.length === 0) {
      insights.push('尚无足够的任务数据进行分析');
      return insights;
    }

    // Find most accurate task type
    const mostAccurate = summaries.reduce((best, s) =>
      s.estimationAccuracy > best.estimationAccuracy ? s : best
    );
    insights.push(`预测最准确的任务类型: ${mostAccurate.taskType} (${Math.round(mostAccurate.estimationAccuracy * 100)}%)`);

    // Find most time-consuming task type
    const mostTimeConsuming = summaries.reduce((max, s) =>
      s.avgDuration > max.avgDuration ? s : max
    );
    insights.push(`最耗时的任务类型: ${mostTimeConsuming.taskType} (平均 ${Math.round(mostTimeConsuming.avgDuration / 60)} 分钟)`);

    // Find most common task type
    const mostCommon = summaries.reduce((max, s) =>
      s.taskCount > max.taskCount ? s : max
    );
    insights.push(`最常见的任务类型: ${mostCommon.taskType} (${mostCommon.taskCount} 次)`);

    // Calculate overall estimation accuracy
    const overallAccuracy = summaries.reduce((sum, s) => sum + s.estimationAccuracy, 0) / summaries.length;
    insights.push(`整体预测准确度: ${Math.round(overallAccuracy * 100)}%`);

    return insights;
  }

  /**
   * Generate overall recommendations.
   */
  private generateOverallRecommendations(summaries: TaskTypeSummary[]): string[] {
    const recommendations: string[] = [];

    if (summaries.length === 0) {
      recommendations.push('建议执行更多任务以收集数据');
      return recommendations;
    }

    // Check for consistently underestimated task types
    const underestimatedTypes = summaries.filter(s =>
      s.patterns.includes('普遍低估时间')
    );
    if (underestimatedTypes.length > 0) {
      recommendations.push(
        `以下任务类型经常低估: ${underestimatedTypes.map(s => s.taskType).join(', ')}`
      );
    }

    // Check for task types with high variance
    const highVarianceTypes = summaries.filter(s =>
      s.patterns.includes('任务时间变化大，难以预测')
    );
    if (highVarianceTypes.length > 0) {
      recommendations.push(
        `以下任务类型变化较大，建议进一步分类: ${highVarianceTypes.map(s => s.taskType).join(', ')}`
      );
    }

    // General recommendation
    const totalTasks = summaries.reduce((sum, s) => sum + s.taskCount, 0);
    if (totalTasks < 50) {
      recommendations.push('建议继续收集数据，目标是至少 50 个任务样本');
    }

    return recommendations;
  }

  /**
   * Get date range of analyzed tasks.
   */
  private async getDateRange(): Promise<{ from: string; to: string }> {
    const reliableTypes = await taskHistoryStorage.getReliableTaskTypes();

    if (reliableTypes.length === 0) {
      return {
        from: new Date().toISOString(),
        to: new Date().toISOString(),
      };
    }

    let minTime = Infinity;
    let maxTime = 0;

    for (const taskType of reliableTypes) {
      const tasks = await taskHistoryStorage.getSimilarTasks(taskType, 100);
      for (const task of tasks) {
        minTime = Math.min(minTime, task.startedAt);
        maxTime = Math.max(maxTime, task.completedAt);
      }
    }

    return {
      from: minTime === Infinity ? new Date().toISOString() : new Date(minTime).toISOString(),
      to: maxTime === 0 ? new Date().toISOString() : new Date(maxTime).toISOString(),
    };
  }

  /**
   * Get recommendations for a specific task type.
   */
  async getRecommendations(taskType: string): Promise<string[]> {
    const summary = await this.analyzeTaskType(taskType);
    return summary?.recommendations ?? ['暂无足够数据提供建议'];
  }

  /**
   * Save summary report to disk.
   */
  private async saveReport(report: SummaryReport): Promise<void> {
    try {
      const workspaceDir = process.env.WORKSPACE_DIR || process.cwd();
      const reportsDir = resolve(workspaceDir, this.config.reportsDir);
      await fs.mkdir(reportsDir, { recursive: true });

      const filename = `summary-${new Date().toISOString().split('T')[0]}.json`;
      const filepath = join(reportsDir, filename);

      await fs.writeFile(filepath, JSON.stringify(report, null, 2));
      logger.info({ filepath }, 'Summary report saved');

    } catch (error) {
      logger.error({ err: error }, 'Failed to save summary report');
    }
  }

  /**
   * Format summary report for display.
   */
  formatReport(report: SummaryReport): string {
    const lines: string[] = [];

    lines.push('# 任务执行总结报告');
    lines.push('');
    lines.push(`**生成时间**: ${report.generatedAt}`);
    lines.push(`**分析任务数**: ${report.totalTasks}`);
    lines.push(`**时间范围**: ${report.dateRange.from} ~ ${report.dateRange.to}`);
    lines.push('');

    // Insights
    lines.push('## 关键洞察');
    for (const insight of report.insights) {
      lines.push(`- ${insight}`);
    }
    lines.push('');

    // Task type summaries
    lines.push('## 任务类型分析');
    for (const summary of report.taskTypeSummaries) {
      lines.push('');
      lines.push(`### ${summary.taskType}`);
      lines.push(`- **任务数量**: ${summary.taskCount}`);
      lines.push(`- **平均耗时**: ${this.formatDuration(summary.avgDuration)}`);
      lines.push(`- **时间范围**: ${this.formatDuration(summary.minDuration)} ~ ${this.formatDuration(summary.maxDuration)}`);
      lines.push(`- **预测准确度**: ${Math.round(summary.estimationAccuracy * 100)}%`);
      if (summary.patterns.length > 0) {
        lines.push(`- **模式**: ${summary.patterns.join(', ')}`);
      }
      if (summary.recommendations.length > 0) {
        lines.push(`- **建议**: ${summary.recommendations.join('; ')}`);
      }
    }

    // Overall recommendations
    if (report.overallRecommendations.length > 0) {
      lines.push('');
      lines.push('## 总体建议');
      for (const rec of report.overallRecommendations) {
        lines.push(`- ${rec}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Format duration in human-readable format.
   */
  private formatDuration(seconds: number): string {
    if (seconds < 60) {
      return `${Math.round(seconds)} 秒`;
    }
    const minutes = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    if (minutes < 60) {
      return secs > 0 ? `${minutes} 分 ${secs} 秒` : `${minutes} 分钟`;
    }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`;
  }
}

/**
 * Global task summary service instance.
 */
export const taskSummaryService = new TaskSummaryService();
