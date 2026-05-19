/**
 * EtaRulesUpdater — analyzes task records and updates ETA estimation rules.
 *
 * Issue #1234 Phase 2: ETA Learning Method
 *
 * Reads `.claude/task-records.md`, extracts patterns about estimation accuracy
 * per task type, and updates `.claude/eta-rules.md` with learned rules.
 *
 * Design principles (from owner feedback on rejected PR #1237):
 * - **Unstructured Markdown** — no TypeScript interfaces for storage
 * - Rules are maintained as a free-form Markdown document
 * - Pattern extraction is string-based, not schema-based
 *
 * @module task/eta-rules-updater
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('EtaRulesUpdater');

/** Relative path from workspace to ETA rules file */
const ETA_RULES_RELATIVE = '.claude/eta-rules.md';

/** Default ETA rules template used when no rules file exists */
const DEFAULT_ETA_RULES = `# ETA 估计规则

## 任务类型基准时间

| 类型 | 基准时间 | 备注 |
|------|---------|------|
| bugfix | 15-30分钟 | 取决于复现难度 |
| feature-small | 30-60分钟 | 单一功能点 |
| feature-medium | 2-4小时 | 需要多个组件配合 |
| refactoring | 视范围而定 | 需要评估影响面 |
| test | 15-45分钟 | 取决于测试复杂度 |
| docs | 10-20分钟 | 文档更新 |
| chore | 5-15分钟 | 简单操作 |
| research | 30-60分钟 | 调研分析 |

## 经验规则

1. **涉及认证/安全的任务** → 基准时间 × 1.5
2. **需要修改核心模块** → 基准时间 × 2
3. **有现成参考代码** → 基准时间 × 0.7
4. **涉及第三方 API 集成** → 基准时间 × 1.5 + 调试时间

## 历史偏差分析

- 低估场景: 涉及异步逻辑、状态管理
- 高估场景: 简单的 CRUD 操作

## 最近更新

- 初始版本，随任务记录积累自动更新
`;

/**
 * Parse a time string like "30分钟", "1小时30分钟", "2小时" into minutes.
 * Returns 0 if the string cannot be parsed.
 */
export function parseTimeToMinutes(timeStr: string): number {
  if (!timeStr || timeStr === '未估计' || timeStr === '未记录') {
    return 0;
  }

  let totalMinutes = 0;

  // Match hours
  const hoursMatch = timeStr.match(/(\d+)\s*小时/);
  if (hoursMatch) {
    totalMinutes += parseInt(hoursMatch[1], 10) * 60;
  }

  // Match minutes
  const minutesMatch = timeStr.match(/(\d+)\s*分钟/);
  if (minutesMatch) {
    totalMinutes += parseInt(minutesMatch[1], 10);
  }

  // If no units matched, try plain number as minutes
  if (totalMinutes === 0) {
    const plainNumber = timeStr.match(/^(\d+)$/);
    if (plainNumber) {
      totalMinutes = parseInt(plainNumber[1], 10);
    }
  }

  return totalMinutes;
}

/**
 * Extract task records from Markdown content.
 * Returns an array of raw record objects parsed from the ## sections.
 *
 * Each section in task-records.md looks like:
 * ```
 * ## 2026-05-18 Fix login bug
 *
 * - **类型**: bugfix
 * - **估计时间**: 30分钟
 * - **估计依据**: Similar to previous fix
 * - **实际时间**: 45分钟
 * - **复盘**: Underestimated complexity
 * ```
 */
export function extractRecordsFromMarkdown(content: string): Array<{
  title: string;
  type: string;
  estimatedTime: string;
  actualTime: string;
  estimationBasis: string;
  review: string;
}> {
  const records: Array<{
    title: string;
    type: string;
    estimatedTime: string;
    actualTime: string;
    estimationBasis: string;
    review: string;
  }> = [];

  // Split by ## headings (skip the # Task Records header)
  const sections = content.split(/\n(?=## )/);

  for (const section of sections) {
    // Skip the main header
    if (section.startsWith('# Task Records')) {
      continue;
    }

    // Extract title from ## heading
    const titleMatch = section.match(/^##\s+\d{4}-\d{2}-\d{2}\s+(.+)/);
    if (!titleMatch) {
      continue;
    }

    const title = titleMatch[1].trim();

    // Extract fields
    const typeMatch = section.match(/\*\*类型\*\*:\s*(.+)/);
    const estimatedMatch = section.match(/\*\*估计时间\*\*:\s*(.+)/);
    const actualMatch = section.match(/\*\*实际时间\*\*:\s*(.+)/);
    const basisMatch = section.match(/\*\*估计依据\*\*:\s*(.+)/);
    const reviewMatch = section.match(/\*\*复盘\*\*:\s*(.+)/);

    records.push({
      title,
      type: typeMatch ? typeMatch[1].trim() : 'unknown',
      estimatedTime: estimatedMatch ? estimatedMatch[1].trim() : '',
      actualTime: actualMatch ? actualMatch[1].trim() : '',
      estimationBasis: basisMatch ? basisMatch[1].trim() : '',
      review: reviewMatch ? reviewMatch[1].trim() : '',
    });
  }

  return records;
}

/**
 * Analyze records and compute per-type statistics.
 * Returns a map of task type → { count, avgEstimatedMin, avgActualMin, avgRatio }.
 *
 * The ratio is actual / estimated:
 * - > 1 means tasks of this type tend to be underestimated
 * - < 1 means tasks of this type tend to be overestimated
 * - ~ 1 means accurate estimation
 */
export function analyzeTypePatterns(records: Array<{
  type: string;
  estimatedTime: string;
  actualTime: string;
}>): Map<string, {
  count: number;
  avgEstimatedMin: number;
  avgActualMin: number;
  avgRatio: number;
}> {
  const typeData = new Map<string, {
    totalEstimate: number;
    totalActual: number;
    count: number;
    ratioSum: number;
  }>();

  for (const record of records) {
    const estMin = parseTimeToMinutes(record.estimatedTime);
    const actMin = parseTimeToMinutes(record.actualTime);

    // Skip records without both times
    if (estMin === 0 || actMin === 0) {
      continue;
    }

    const existing = typeData.get(record.type) || {
      totalEstimate: 0,
      totalActual: 0,
      count: 0,
      ratioSum: 0,
    };

    existing.totalEstimate += estMin;
    existing.totalActual += actMin;
    existing.count += 1;
    existing.ratioSum += actMin / estMin;

    typeData.set(record.type, existing);
  }

  // Convert to output format
  const result = new Map<string, {
    count: number;
    avgEstimatedMin: number;
    avgActualMin: number;
    avgRatio: number;
  }>();

  for (const [type, data] of typeData) {
    if (data.count === 0) { continue; }
    result.set(type, {
      count: data.count,
      avgEstimatedMin: Math.round(data.totalEstimate / data.count),
      avgActualMin: Math.round(data.totalActual / data.count),
      avgRatio: Math.round((data.ratioSum / data.count) * 100) / 100,
    });
  }

  return result;
}

/**
 * Build an updated "历史偏差分析" section from pattern analysis.
 */
function buildBiasSection(patterns: Map<string, {
  count: number;
  avgEstimatedMin: number;
  avgActualMin: number;
  avgRatio: number;
}>): string {
  const underestimated: string[] = [];
  const overestimated: string[] = [];
  const accurate: string[] = [];

  for (const [type, stats] of patterns) {
    if (stats.count < 2) { continue; } // Need at least 2 samples

    if (stats.avgRatio > 1.3) {
      underestimated.push(`${type} (实际/估计: ${stats.avgRatio}x, 平均实际 ${stats.avgActualMin}分钟)`);
    } else if (stats.avgRatio < 0.7) {
      overestimated.push(`${type} (实际/估计: ${stats.avgRatio}x, 平均实际 ${stats.avgActualMin}分钟)`);
    } else {
      accurate.push(`${type} (实际/估计: ${stats.avgRatio}x)`);
    }
  }

  const lines: string[] = [];
  if (underestimated.length > 0) {
    lines.push(`- 低估场景: ${underestimated.join(', ')}`);
  } else {
    lines.push('- 低估场景: 暂无足够数据');
  }
  if (overestimated.length > 0) {
    lines.push(`- 高估场景: ${overestimated.join(', ')}`);
  } else {
    lines.push('- 高估场景: 暂无足够数据');
  }
  if (accurate.length > 0) {
    lines.push(`- 准确估计: ${accurate.join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Build an updated "任务类型基准时间" table from pattern analysis.
 */
function buildBaselineTable(patterns: Map<string, {
  count: number;
  avgEstimatedMin: number;
  avgActualMin: number;
  avgRatio: number;
}>): string {
  const defaultBaselines: Record<string, string> = {
    bugfix: '15-30分钟',
    'feature-small': '30-60分钟',
    'feature-medium': '2-4小时',
    refactoring: '视范围而定',
    test: '15-45分钟',
    docs: '10-20分钟',
    chore: '5-15分钟',
    research: '30-60分钟',
  };

  // Start with known types
  const allTypes = new Set<string>([
    ...Object.keys(defaultBaselines),
    ...patterns.keys(),
  ]);

  const lines: string[] = [
    '| 类型 | 基准时间 | 备注 |',
    '|------|---------|------|',
  ];

  for (const type of allTypes) {
    const stats = patterns.get(type);
    const defaultBase = defaultBaselines[type];

    if (stats && stats.count >= 2) {
      // We have enough data — use actual average as baseline
      const avgMin = stats.avgActualMin;
      let baseline: string;
      if (avgMin < 15) {
        baseline = '5-15分钟';
      } else if (avgMin < 30) {
        baseline = '15-30分钟';
      } else if (avgMin < 60) {
        baseline = '30-60分钟';
      } else if (avgMin < 120) {
        baseline = '1-2小时';
      } else if (avgMin < 240) {
        baseline = '2-4小时';
      } else {
        baseline = `${Math.round(avgMin / 60)}小时+`;
      }
      lines.push(`| ${type} | ${baseline} | 基于 ${stats.count} 次记录 (偏差 ${stats.avgRatio}x) |`);
    } else if (defaultBase) {
      lines.push(`| ${type} | ${defaultBase} | 默认值 |`);
    } else {
      // Unknown type with insufficient data
      lines.push(`| ${type} | 待观察 | 仅 ${stats?.count || 0} 次记录 |`);
    }
  }

  return lines.join('\n');
}

/**
 * EtaRulesUpdater — reads task records, learns patterns, and updates ETA rules.
 *
 * Usage:
 * ```typescript
 * const updater = new EtaRulesUpdater(workspaceDir);
 * await updater.updateRules(); // Analyze records & update rules
 * const rules = await updater.readRules(); // Read current rules
 * ```
 */
export class EtaRulesUpdater {
  private readonly claudeDir: string;
  private readonly rulesPath: string;
  private readonly recordsPath: string;

  constructor(workspaceDir: string) {
    this.claudeDir = path.join(workspaceDir, '.claude');
    this.rulesPath = path.join(workspaceDir, ETA_RULES_RELATIVE);
    this.recordsPath = path.join(workspaceDir, '.claude', 'task-records.md');
  }

  /**
   * Get the path to the ETA rules file.
   */
  getRulesPath(): string {
    return this.rulesPath;
  }

  /**
   * Read the current ETA rules as raw Markdown.
   * Returns the default template if no rules file exists.
   */
  async readRules(): Promise<string> {
    try {
      return await fs.readFile(this.rulesPath, 'utf-8');
    } catch {
      return DEFAULT_ETA_RULES;
    }
  }

  /**
   * Ensure the rules file exists with the default template.
   * Creates the .claude directory if needed.
   */
  async ensureRulesFile(): Promise<void> {
    try {
      await fs.mkdir(this.claudeDir, { recursive: true });
      try {
        await fs.access(this.rulesPath);
      } catch {
        await fs.writeFile(this.rulesPath, DEFAULT_ETA_RULES, 'utf-8');
        logger.info('Created default ETA rules file');
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to create ETA rules file');
    }
  }

  /**
   * Read task records from the Markdown file.
   * Returns empty string if no records exist.
   */
  async readRecords(): Promise<string> {
    try {
      return await fs.readFile(this.recordsPath, 'utf-8');
    } catch {
      return '';
    }
  }

  /**
   * Analyze task records and update the ETA rules file.
   *
   * This method:
   * 1. Reads all task records
   * 2. Extracts patterns per task type
   * 3. Updates the "任务类型基准时间" and "历史偏差分析" sections
   * 4. Appends an update entry to "最近更新"
   *
   * @returns The updated rules content, or empty string if no records to learn from.
   */
  async updateRules(): Promise<string> {
    const recordsContent = await this.readRecords();
    if (!recordsContent) {
      logger.info('No task records found, skipping rules update');
      return '';
    }

    const records = extractRecordsFromMarkdown(recordsContent);
    if (records.length === 0) {
      logger.info('No parseable task records, skipping rules update');
      return '';
    }

    const patterns = analyzeTypePatterns(records);
    if (patterns.size === 0) {
      logger.info('No records with both estimate and actual time, skipping rules update');
      return '';
    }

    // Read existing rules or use default
    let rulesContent = await this.readRules();

    // Update the baseline table section
    const newTable = buildBaselineTable(patterns);
    rulesContent = rulesContent.replace(
      /## 任务类型基准时间\n\n\|.*?(?=\n## |\n*$)/s,
      `## 任务类型基准时间\n\n${newTable}`
    );

    // Update the bias analysis section
    const newBias = buildBiasSection(patterns);
    rulesContent = rulesContent.replace(
      /## 历史偏差分析\n\n.*?(?=\n## |\n*$)/s,
      `## 历史偏差分析\n\n${newBias}`
    );

    // Update the "最近更新" section with timestamp
    const date = new Date().toISOString().slice(0, 10);
    const recordCount = records.length;
    const typeCount = patterns.size;
    const updateLine = `- ${date}: 自动更新 — 基于 ${recordCount} 条任务记录, ${typeCount} 种类型`;

    // Remove previous auto-update lines (keep manual entries)
    rulesContent = rulesContent.replace(
      /^- \d{4}-\d{2}-\d{2}: 自动更新.*$/gm,
      ''
    );

    // Append update line to 最近更新 section
    rulesContent = rulesContent.replace(
      /(## 最近更新\n\n)/,
      `$1${updateLine}\n`
    );

    // Clean up multiple blank lines
    rulesContent = rulesContent.replace(/\n{3,}/g, '\n\n');

    // Write updated rules
    await this.ensureRulesFile();
    await fs.writeFile(this.rulesPath, rulesContent, 'utf-8');

    logger.info({ recordCount, typeCount }, 'ETA rules updated from task records');
    return rulesContent;
  }
}
