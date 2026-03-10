/**
 * ETA Rules - Markdown-based estimation rules for ETA prediction.
 *
 * Issue #1234: Task ETA Estimation System
 *
 * Key Design Principle: Uses UNSTRUCTURED Markdown storage instead of structured data.
 * This allows:
 * - Free-form estimation rules that evolve with experience
 * - Human-readable and manually editable
 * - Easy addition of new rules and patterns
 *
 * @module agents/eta-rules
 */

import { createLogger } from '../utils/logger.js';
import { promises as fs } from 'fs';
import { resolve } from 'path';

const logger = createLogger('ETARules');

/**
 * Task type baseline time configuration.
 */
export interface TaskTypeBaseline {
  /** Task type name */
  type: string;
  /** Baseline time range (e.g., "15-30分钟") */
  baselineTime: string;
  /** Minimum seconds */
  minSeconds: number;
  /** Maximum seconds */
  maxSeconds: number;
  /** Notes about this task type */
  notes: string;
}

/**
 * ETA estimation rule.
 */
export interface ETAEstimationRule {
  /** Rule condition/pattern */
  condition: string;
  /** Time multiplier (e.g., 1.5 means 50% more time) */
  multiplier: number;
  /** Description of when to apply this rule */
  description: string;
}

/**
 * ETA Rules Manager.
 *
 * Manages estimation rules in Markdown format for ETA prediction.
 */
export class ETARules {
  private readonly rulesFile: string;
  private initialized = false;
  private cachedContent: string | null = null;

  constructor(workspaceDir?: string) {
    const workspace = workspaceDir || process.env.WORKSPACE_DIR || process.cwd();
    this.rulesFile = resolve(workspace, '.claude', 'eta-rules.md');
  }

  /**
   * Initialize the rules file if it doesn't exist.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const dir = resolve(this.rulesFile, '..');
      await fs.mkdir(dir, { recursive: true });

      // Check if file exists, if not create with default rules
      try {
        await fs.access(this.rulesFile);
        logger.debug('ETA rules file exists');
      } catch {
        // Create new file with default rules
        await fs.writeFile(this.rulesFile, this.getDefaultRules(), 'utf-8');
        logger.info('Created new ETA rules file with defaults');
      }

      this.initialized = true;
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize ETA rules');
      throw error;
    }
  }

  /**
   * Read all rules from the Markdown file.
   */
  async readRules(): Promise<string> {
    await this.ensureInitialized();

    if (this.cachedContent) {
      return this.cachedContent;
    }

    try {
      const content = await fs.readFile(this.rulesFile, 'utf-8');
      this.cachedContent = content;
      return content;
    } catch (error) {
      logger.error({ err: error }, 'Failed to read ETA rules');
      throw error;
    }
  }

  /**
   * Get task type baselines from the rules file.
   */
  async getTaskTypeBaselines(): Promise<TaskTypeBaseline[]> {
    const content = await this.readRules();
    return this.parseTaskTypeBaselines(content);
  }

  /**
   * Get estimation rules from the rules file.
   */
  async getEstimationRules(): Promise<ETAEstimationRule[]> {
    const content = await this.readRules();
    return this.parseEstimationRules(content);
  }

  /**
   * Find applicable rules for a task description.
   */
  async findApplicableRules(taskDescription: string): Promise<ETAEstimationRule[]> {
    const rules = await this.getEstimationRules();
    const desc = taskDescription.toLowerCase();

    return rules.filter(rule => {
      // Check if any keywords from the condition appear in the description
      const keywords = rule.condition.toLowerCase().split(/[,\s]+/);
      return keywords.some(kw => kw.length > 2 && desc.includes(kw));
    });
  }

  /**
   * Get baseline time for a task type.
   */
  async getBaselineForType(taskType: string): Promise<TaskTypeBaseline | undefined> {
    const baselines = await this.getTaskTypeBaselines();
    return baselines.find(b =>
      b.type.toLowerCase() === taskType.toLowerCase() ||
      taskType.toLowerCase().includes(b.type.toLowerCase())
    );
  }

  /**
   * Append a new rule to the rules file.
   */
  async addRule(rule: ETAEstimationRule): Promise<void> {
    await this.ensureInitialized();

    const entry = this.formatRuleEntry(rule);

    try {
      // Find the position to insert (before the last section or at the end)
      const content = await fs.readFile(this.rulesFile, 'utf-8');

      // Find the "## 最近更新" section or append at the end
      const updateSectionMatch = content.match(/\n## 最近更新/);
      let insertPosition = content.length;

      if (updateSectionMatch && updateSectionMatch.index) {
        insertPosition = updateSectionMatch.index;
      }

      const newContent =
        content.slice(0, insertPosition) +
        entry +
        '\n' +
        content.slice(insertPosition);

      await fs.writeFile(this.rulesFile, newContent, 'utf-8');
      this.cachedContent = null; // Clear cache

      logger.info({ condition: rule.condition }, 'Added new ETA rule');
    } catch (error) {
      logger.error({ err: error }, 'Failed to add ETA rule');
      throw error;
    }
  }

  /**
   * Record a lesson learned from a task execution.
   */
  async recordLesson(date: string, lesson: string): Promise<void> {
    await this.ensureInitialized();

    const entry = `- ${date}: ${lesson}\n`;

    try {
      const content = await fs.readFile(this.rulesFile, 'utf-8');

      // Find the "## 最近更新" section and add the entry
      const updateSectionMatch = content.match(/## 最近更新\n\n/);
      let newContent: string;

      if (updateSectionMatch && updateSectionMatch.index !== undefined) {
        const insertPos = updateSectionMatch.index + updateSectionMatch[0].length;
        newContent =
          content.slice(0, insertPos) +
          entry +
          content.slice(insertPos);
      } else {
        // Append at the end if section not found
        newContent = content + '\n## 最近更新\n\n' + entry;
      }

      await fs.writeFile(this.rulesFile, newContent, 'utf-8');
      this.cachedContent = null; // Clear cache

      logger.info({ lesson }, 'Recorded ETA lesson');
    } catch (error) {
      logger.error({ err: error }, 'Failed to record lesson');
      throw error;
    }
  }

  /**
   * Parse task type baselines from Markdown content.
   */
  private parseTaskTypeBaselines(content: string): TaskTypeBaseline[] {
    const baselines: TaskTypeBaseline[] = [];

    // Find the task type table
    const tableMatch = content.match(/\| 类型 \| 基准时间 \| 备注 \|[\s\S]*?(?=\n##|\n$)/);
    if (!tableMatch) {
      return baselines;
    }

    const lines = tableMatch[0].split('\n').slice(2); // Skip header and separator

    for (const line of lines) {
      const cells = line.split('|').map(c => c.trim()).filter(c => c);
      if (cells.length >= 3) {
        const [type, baselineTime, notes] = cells;
        const { min, max } = this.parseTimeRange(baselineTime);
        baselines.push({
          type,
          baselineTime,
          minSeconds: min,
          maxSeconds: max,
          notes,
        });
      }
    }

    return baselines;
  }

  /**
   * Parse estimation rules from Markdown content.
   */
  private parseEstimationRules(content: string): ETAEstimationRule[] {
    const rules: ETAEstimationRule[] = [];

    // Find the experience rules section
    const rulesMatch = content.match(/## 经验规则[\s\S]*?(?=\n##|\n$)/);
    if (!rulesMatch) {
      return rules;
    }

    const lines = rulesMatch[0].split('\n');

    for (const line of lines) {
      // Match patterns like "1. **条件** → 基准时间 × 1.5"
      const ruleMatch = line.match(/\d+\.\s*\*\*(.+?)\*\*\s*→\s*基准时间\s*[×x]\s*([\d.]+)/);
      if (ruleMatch) {
        rules.push({
          condition: ruleMatch[1].trim(),
          multiplier: parseFloat(ruleMatch[2]),
          description: `Apply ${ruleMatch[2]}x multiplier when task involves ${ruleMatch[1].trim()}`,
        });
      }
    }

    return rules;
  }

  /**
   * Parse time range string to min/max seconds.
   */
  private parseTimeRange(rangeStr: string): { min: number; max: number } {
    let min = 0;
    let max = 0;

    // Handle "X-Y分钟" format
    const rangeMatch = rangeStr.match(/(\d+)-(\d+)\s*分钟/);
    if (rangeMatch) {
      min = parseInt(rangeMatch[1], 10) * 60;
      max = parseInt(rangeMatch[2], 10) * 60;
      return { min, max };
    }

    // Handle "X-Y小时" format
    const hourRangeMatch = rangeStr.match(/(\d+)-(\d+)\s*小时/);
    if (hourRangeMatch) {
      min = parseInt(hourRangeMatch[1], 10) * 3600;
      max = parseInt(hourRangeMatch[2], 10) * 3600;
      return { min, max };
    }

    // Handle single value
    const singleMatch = rangeStr.match(/(\d+)\s*(分钟|小时)/);
    if (singleMatch) {
      const value = parseInt(singleMatch[1], 10);
      const unit = singleMatch[2];
      const seconds = unit === '小时' ? value * 3600 : value * 60;
      return { min: seconds, max: seconds };
    }

    // Default fallback
    return { min: 1800, max: 3600 }; // 30-60 minutes
  }

  /**
   * Format a rule as Markdown entry.
   */
  private formatRuleEntry(rule: ETAEstimationRule): string {
    return `\n${rule.multiplier >= 1 ? '+' : ''}${Math.round((rule.multiplier - 1) * 100)}%: ${rule.condition} → 基准时间 × ${rule.multiplier}`;
  }

  /**
   * Get default rules content.
   */
  private getDefaultRules(): string {
    return `# ETA 估计规则

此文件记录任务时间估计的规则和经验，用于 ETA 预估系统。

## 任务类型基准时间

| 类型 | 基准时间 | 备注 |
|------|---------|------|
| bugfix | 15-30分钟 | 取决于复现难度 |
| feature-small | 30-60分钟 | 单一功能点 |
| feature-medium | 2-4小时 | 需要多个组件配合 |
| feature-large | 1-2天 | 复杂功能，需要设计 |
| refactoring | 视范围而定 | 需要评估影响面 |
| documentation | 15-45分钟 | 文档编写 |
| testing | 30-60分钟 | 测试编写 |

## 经验规则

1. **涉及认证/安全的任务** → 基准时间 × 1.5
2. **需要修改核心模块** → 基准时间 × 2
3. **有现成参考代码** → 基准时间 × 0.7
4. **涉及第三方 API 集成** → 基准时间 × 1.5
5. **涉及异步逻辑** → 基准时间 × 1.3
6. **需要数据库迁移** → 基准时间 × 1.5
7. **涉及 UI/样式调整** → 基准时间 × 1.2
8. **首次处理该类型任务** → 基准时间 × 1.5

## 历史偏差分析

- **低估场景**: 涉及异步逻辑、状态管理、边界条件处理
- **高估场景**: 简单的 CRUD 操作、有现成模板可参考

## 最近更新

- ${new Date().toISOString().split('T')[0]}: 初始化 ETA 规则文档
`;
  }

  /**
   * Ensure storage is initialized.
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Get the file path for debugging.
   */
  getFilePath(): string {
    return this.rulesFile;
  }

  /**
   * Clear the cache (useful after external modifications).
   */
  clearCache(): void {
    this.cachedContent = null;
  }
}

/**
 * Global ETA rules instance.
 */
export const etaRules = new ETARules();
