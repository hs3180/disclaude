/**
 * ETA Tracker - Task Time Estimation System
 *
 * Manages task records and rules for ETA prediction.
 * Uses Markdown files for human-readable storage.
 *
 * File locations:
 * - .claude/task-records.md - Historical task records
 * - .claude/eta-rules.md - Estimation rules
 *
 * @module task/eta-tracker
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger, type Logger } from '../utils/logger.js';
import type {
  EtaTaskRecord,
  EtaRule,
  EtaTaskBaseline,
  EtaPrediction,
  EtaTrackerOptions,
  EtaStats,
  EtaTaskType,
} from './eta-types.js';

/**
 * Default task type baselines.
 * Used when no historical data is available.
 */
const DEFAULT_BASELINES: EtaTaskBaseline[] = [
  { type: 'bugfix', baseTimeMinutes: [15, 30], notes: 'Depends on reproduction difficulty' },
  { type: 'feature-small', baseTimeMinutes: [30, 60], notes: 'Single feature point' },
  { type: 'feature-medium', baseTimeMinutes: [120, 240], notes: 'Multiple components' },
  { type: 'feature-large', baseTimeMinutes: [480, 960], notes: 'Major feature requiring planning' },
  { type: 'refactoring', baseTimeMinutes: [60, 180], notes: 'Depends on scope' },
  { type: 'documentation', baseTimeMinutes: [30, 60], notes: 'Per document' },
  { type: 'testing', baseTimeMinutes: [30, 90], notes: 'Depends on coverage needed' },
  { type: 'integration', baseTimeMinutes: [60, 180], notes: 'Third-party API complexity' },
  { type: 'research', baseTimeMinutes: [60, 240], notes: 'Open-ended' },
  { type: 'other', baseTimeMinutes: [30, 60], notes: 'Default range' },
];

/**
 * Default estimation rules.
 */
const DEFAULT_RULES: Omit<EtaRule, 'updatedAt'>[] = [
  {
    name: 'Authentication/Security',
    description: 'Tasks involving auth/security take longer',
    multiplier: 1.5,
    condition: 'Task involves authentication, authorization, or security',
    sourceTask: 'System default',
  },
  {
    name: 'Core Module Changes',
    description: 'Changes to core modules need more time',
    multiplier: 2.0,
    condition: 'Task modifies core/shared modules',
    sourceTask: 'System default',
  },
  {
    name: 'Reference Code Available',
    description: 'Existing reference code speeds up work',
    multiplier: 0.7,
    condition: 'There is similar existing code to reference',
    sourceTask: 'System default',
  },
  {
    name: 'Third-party API Integration',
    description: 'External APIs add debugging time',
    multiplier: 1.5,
    condition: 'Task requires integration with external API',
    sourceTask: 'System default',
  },
  {
    name: 'Async Logic',
    description: 'Asynchronous logic is often underestimated',
    multiplier: 1.3,
    condition: 'Task involves async/await, promises, or event handling',
    sourceTask: 'System default',
  },
];

/**
 * ETA Tracker for managing task time estimation.
 */
export class EtaTracker {
  private readonly recordsPath: string;
  private readonly rulesPath: string;
  private readonly claudeDir: string;
  private readonly logger: Logger;
  private readonly autoCreate: boolean;

  constructor(options: EtaTrackerOptions) {
    this.claudeDir = path.join(options.workspaceDir, '.claude');
    this.recordsPath = path.join(this.claudeDir, 'task-records.md');
    this.rulesPath = path.join(this.claudeDir, 'eta-rules.md');
    this.logger = createLogger('eta-tracker');
    // Note: maxRecords is reserved for future use
    void options.maxRecords;
    this.autoCreate = options.autoCreate ?? true;
  }

  /**
   * Initialize the ETA tracker.
   * Creates necessary directories and files if they don't exist.
   */
  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.claudeDir, { recursive: true });

      if (this.autoCreate) {
        // Create task-records.md if it doesn't exist
        try {
          await fs.access(this.recordsPath);
        } catch {
          await fs.writeFile(this.recordsPath, this.generateRecordsTemplate(), 'utf-8');
          this.logger.info('Created task-records.md template');
        }

        // Create eta-rules.md if it doesn't exist
        try {
          await fs.access(this.rulesPath);
        } catch {
          await fs.writeFile(this.rulesPath, this.generateRulesTemplate(), 'utf-8');
          this.logger.info('Created eta-rules.md template');
        }
      }
    } catch (error) {
      this.logger.error({ error }, 'Failed to initialize ETA tracker');
      throw error;
    }
  }

  /**
   * Add a new task record.
   *
   * @param record - Task record to add
   */
  async addTaskRecord(record: EtaTaskRecord): Promise<void> {
    await this.initialize();

    const recordMarkdown = this.formatTaskRecord(record);
    const content = await fs.readFile(this.recordsPath, 'utf-8');

    // Find the "## Records" section and prepend the new record
    const recordsSectionIndex = content.indexOf('## Records');
    if (recordsSectionIndex === -1) {
      // Append to end if section not found
      await fs.appendFile(this.recordsPath, '\n\n' + recordMarkdown, 'utf-8');
    } else {
      // Insert after the section header
      const insertIndex = content.indexOf('\n', recordsSectionIndex) + 1;
      const newContent = content.slice(0, insertIndex) + '\n' + recordMarkdown + content.slice(insertIndex);
      await fs.writeFile(this.recordsPath, newContent, 'utf-8');
    }

    this.logger.info({ title: record.title }, 'Added task record');
  }

  /**
   * Add or update an estimation rule.
   *
   * @param rule - Rule to add or update
   */
  async addRule(rule: Omit<EtaRule, 'updatedAt'>): Promise<void> {
    await this.initialize();

    const rules = await this.loadRules();
    const existingIndex = rules.findIndex(r => r.name === rule.name);

    const newRule: EtaRule = {
      ...rule,
      updatedAt: new Date().toISOString().split('T')[0],
    };

    if (existingIndex >= 0) {
      rules[existingIndex] = newRule;
    } else {
      rules.push(newRule);
    }

    await this.saveRules(rules);
    this.logger.info({ name: rule.name }, 'Updated estimation rule');
  }

  /**
   * Predict ETA for a task.
   *
   * @param description - Task description
   * @param type - Task type
   * @returns ETA prediction with reasoning
   */
  async predictEta(description: string, type: EtaTaskType): Promise<EtaPrediction> {
    await this.initialize();

    // Get baseline time for task type
    const baseline = DEFAULT_BASELINES.find(b => b.type === type) ?? DEFAULT_BASELINES[DEFAULT_BASELINES.length - 1];
    let [minTime, maxTime] = baseline.baseTimeMinutes;
    const appliedRules: string[] = [];
    const reasoningSteps: string[] = [];

    // Step 1: Task type baseline
    reasoningSteps.push(`1. Task type: ${type}, baseline time ${minTime}-${maxTime} minutes`);

    // Step 2: Apply rules
    const rules = await this.loadRules();
    for (const rule of rules) {
      if (this.matchesCondition(description, rule.condition)) {
        minTime = Math.round(minTime * rule.multiplier);
        maxTime = Math.round(maxTime * rule.multiplier);
        appliedRules.push(rule.name);
        reasoningSteps.push(`2. ${rule.name}: x ${rule.multiplier} -> ${minTime}-${maxTime} minutes`);
      }
    }

    // Step 3: Check similar historical tasks
    const records = await this.loadRecords();
    const similarTasks = this.findSimilarTasks(description, type, records);
    if (similarTasks.length > 0) {
      const avgActual = similarTasks.reduce((sum, t) => sum + t.actualMinutes, 0) / similarTasks.length;
      reasoningSteps.push(`3. Referenced ${similarTasks.length} similar task(s), avg actual time: ${Math.round(avgActual)} minutes`);
      // Blend historical data with estimate
      minTime = Math.round((minTime + avgActual) / 2);
      maxTime = Math.round((maxTime + avgActual) / 2);
    } else {
      reasoningSteps.push('3. No similar historical tasks found');
    }

    // Calculate final estimate
    const estimatedMinutes = Math.round((minTime + maxTime) / 2);

    // Determine confidence
    let confidence: 'low' | 'medium' | 'high';
    if (records.length < 5) {
      confidence = 'low';
    } else if (similarTasks.length > 0 && appliedRules.length > 0) {
      confidence = 'high';
    } else {
      confidence = 'medium';
    }

    reasoningSteps.push(`4. Final estimate: ${estimatedMinutes} minutes (confidence: ${confidence})`);

    return {
      estimatedMinutes,
      confidence,
      reasoning: reasoningSteps.join('\n'),
      appliedRules,
      referencedTasks: similarTasks.slice(0, 3).map(t => t.title),
    };
  }

  /**
   * Get statistics about ETA accuracy.
   */
  async getStats(): Promise<EtaStats> {
    await this.initialize();

    const records = await this.loadRecords();

    if (records.length === 0) {
      return {
        totalTasks: 0,
        averageError: 0,
        underestimatedRate: 0,
        overestimatedRate: 0,
        mostCommonType: null,
      };
    }

    // Calculate average error
    const errors = records.map(r => {
      const error = ((r.actualMinutes - r.estimatedMinutes) / r.estimatedMinutes) * 100;
      return error;
    });
    const averageError = errors.reduce((sum, e) => sum + Math.abs(e), 0) / errors.length;

    // Count under/over estimates
    const underestimated = errors.filter(e => e > 20).length;
    const overestimated = errors.filter(e => e < -20).length;

    // Find most common type
    const typeCounts = new Map<EtaTaskType, number>();
    for (const record of records) {
      typeCounts.set(record.type, (typeCounts.get(record.type) ?? 0) + 1);
    }
    let mostCommonType: EtaTaskType | null = null;
    let maxCount = 0;
    for (const [type, count] of typeCounts) {
      if (count > maxCount) {
        maxCount = count;
        mostCommonType = type;
      }
    }

    return {
      totalTasks: records.length,
      averageError: Math.round(averageError),
      underestimatedRate: Math.round((underestimated / records.length) * 100),
      overestimatedRate: Math.round((overestimated / records.length) * 100),
      mostCommonType,
    };
  }

  /**
   * Load all task records.
   */
  async loadRecords(): Promise<EtaTaskRecord[]> {
    try {
      const content = await fs.readFile(this.recordsPath, 'utf-8');
      return this.parseRecords(content);
    } catch {
      return [];
    }
  }

  /**
   * Load all estimation rules.
   */
  async loadRules(): Promise<EtaRule[]> {
    try {
      const content = await fs.readFile(this.rulesPath, 'utf-8');
      return this.parseRules(content);
    } catch {
      return [];
    }
  }

  /**
   * Save rules to file.
   */
  private async saveRules(rules: EtaRule[]): Promise<void> {
    const content = this.generateRulesContent(rules);
    await fs.writeFile(this.rulesPath, content, 'utf-8');
  }

  /**
   * Parse task records from Markdown content.
   */
  private parseRecords(content: string): EtaTaskRecord[] {
    const records: EtaTaskRecord[] = [];
    const sections = content.split(/## \d{4}-\d{2}-\d{2}/);

    for (const section of sections.slice(1)) {
      try {
        const record = this.parseRecordSection(section);
        if (record) {
          records.push(record);
        }
      } catch {
        // Skip malformed records
      }
    }

    return records;
  }

  /**
   * Parse a single record section.
   */
  private parseRecordSection(section: string): EtaTaskRecord | null {
    const titleMatch = section.match(/^\s+(.+)$/m);
    const typeMatch = section.match(/\*\*类型\*\*:\s*(.+)/);
    const estimatedMatch = section.match(/\*\*估计时间\*\*:\s*(\d+)/);
    const basisMatch = section.match(/\*\*估计依据\*\*:\s*(.+)/);
    const actualMatch = section.match(/\*\*实际时间\*\*:\s*(\d+)/);
    const reviewMatch = section.match(/\*\*复盘\*\*:\s*(.+)/);

    if (!titleMatch || !estimatedMatch || !actualMatch) {
      return null;
    }

    return {
      title: titleMatch[1].trim(),
      date: '', // Extracted from section header
      type: (typeMatch?.[1].trim() as EtaTaskType) ?? 'other',
      estimatedMinutes: parseInt(estimatedMatch[1], 10),
      estimationBasis: basisMatch?.[1].trim() ?? '',
      actualMinutes: parseInt(actualMatch[1], 10),
      review: reviewMatch?.[1].trim() ?? '',
    };
  }

  /**
   * Parse rules from Markdown content.
   */
  private parseRules(content: string): EtaRule[] {
    const rules: EtaRule[] = [];
    const ruleSections = content.split(/###\s+/).slice(1);

    for (const section of ruleSections) {
      try {
        const rule = this.parseRuleSection(section);
        if (rule) {
          rules.push(rule);
        }
      } catch {
        // Skip malformed rules
      }
    }

    return rules;
  }

  /**
   * Parse a single rule section.
   */
  private parseRuleSection(section: string): EtaRule | null {
    const lines = section.split('\n');
    const name = lines[0]?.trim();

    const descMatch = section.match(/描述:\s*(.+)/);
    const multMatch = section.match(/乘数:\s*([\d.]+)/);
    const condMatch = section.match(/条件:\s*(.+)/);
    const sourceMatch = section.match(/来源:\s*(.+)/);
    const updatedMatch = section.match(/更新时间:\s*(.+)/);

    if (!name || !multMatch) {
      return null;
    }

    return {
      name,
      description: descMatch?.[1].trim() ?? '',
      multiplier: parseFloat(multMatch[1]),
      condition: condMatch?.[1].trim() ?? '',
      sourceTask: sourceMatch?.[1].trim(),
      updatedAt: updatedMatch?.[1].trim() ?? new Date().toISOString().split('T')[0],
    };
  }

  /**
   * Format a task record as Markdown.
   */
  private formatTaskRecord(record: EtaTaskRecord): string {
    return `## ${record.date} ${record.title}

- **类型**: ${record.type}
- **估计时间**: ${record.estimatedMinutes}分钟
- **估计依据**: ${record.estimationBasis}
- **实际时间**: ${record.actualMinutes}分钟
- **复盘**: ${record.review}
`;
  }

  /**
   * Generate rules content for saving.
   */
  private generateRulesContent(rules: EtaRule[]): string {
    const header = `# ETA 估计规则

这些规则基于历史任务学习，用于改进 ETA 预测准确性。

## 规则列表

`;

    const rulesContent = rules.map(rule => `### ${rule.name}

描述: ${rule.description}
乘数: ${rule.multiplier}
条件: ${rule.condition}
来源: ${rule.sourceTask ?? 'N/A'}
更新时间: ${rule.updatedAt}
`).join('\n');

    return header + rulesContent;
  }

  /**
   * Find similar historical tasks.
   */
  private findSimilarTasks(description: string, type: EtaTaskType, records: EtaTaskRecord[]): EtaTaskRecord[] {
    // Simple matching: same type and keyword overlap
    const keywords = this.extractKeywords(description);

    return records
      .filter(r => r.type === type)
      .filter(r => {
        const recordKeywords = this.extractKeywords(r.title + ' ' + r.review);
        const overlap = keywords.filter(k => recordKeywords.includes(k)).length;
        return overlap >= 2; // At least 2 keywords in common
      })
      .slice(0, 5); // Max 5 similar tasks
  }

  /**
   * Extract keywords from text.
   */
  private extractKeywords(text: string): string[] {
    // Simple keyword extraction
    const stopWords = new Set(['的', '了', '是', '在', '和', '与', '或', 'a', 'an', 'the', 'is', 'are', 'was', 'were', 'to', 'for', 'and', 'or']);

    return text
      .toLowerCase()
      .split(/[\s,，。.!！?？:：;；]+/)
      .filter(word => word.length >= 2 && !stopWords.has(word));
  }

  /**
   * Check if description matches a rule condition.
   */
  private matchesCondition(description: string, condition: string): boolean {
    const keywords = condition.toLowerCase().split(/[,，、或or\s]+/);
    const descLower = description.toLowerCase();
    return keywords.some(kw => kw.length >= 3 && descLower.includes(kw.trim()));
  }

  /**
   * Generate template for task-records.md
   */
  private generateRecordsTemplate(): string {
    return `# 任务记录

此文件记录所有已完成任务的执行信息，用于 ETA 学习和预测。

## 记录格式

每条记录包含:
- 任务标题和日期
- 任务类型
- 估计时间和依据
- 实际执行时间
- 复盘反思

## Records

<!-- 新记录会添加到这里 -->

## 统计

_统计信息会在添加记录后自动更新_

`;
  }

  /**
   * Generate template for eta-rules.md
   */
  private generateRulesTemplate(): string {
    const defaultRulesContent = DEFAULT_RULES.map(rule => `### ${rule.name}

描述: ${rule.description}
乘数: ${rule.multiplier}
条件: ${rule.condition}
来源: ${rule.sourceTask}
更新时间: ${new Date().toISOString().split('T')[0]}
`).join('\n');

    const baselinesContent = DEFAULT_BASELINES.map(b => `| ${b.type} | ${b.baseTimeMinutes[0]}-${b.baseTimeMinutes[1]} | ${b.notes} |`).join('\n');

    return `# ETA 估计规则

此文件维护从历史任务中学到的估计规则，可随经验积累进化。

## 任务类型基准时间

| 类型 | 基准时间(分钟) | 备注 |
|------|---------------|------|
${baselinesContent}

## 规则列表

${defaultRulesContent}

## 历史偏差分析

定期分析任务记录，识别：
- 低估场景: 涉及异步逻辑、状态管理
- 高估场景: 简单的 CRUD 操作

## 最近更新

- ${new Date().toISOString().split('T')[0]}: 初始化 ETA 规则文件
`;
  }
}
