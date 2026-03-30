/**
 * ETA Rules Manager - Manages estimation rules for task time prediction.
 *
 * Rules are stored as free-form Markdown in `.claude/eta-rules.md`.
 * The rules document evolves over time as the system learns from
 * historical task execution data.
 *
 * Storage format (Markdown):
 * ```markdown
 * # ETA 估计规则
 *
 * ## 任务类型基准时间
 * | 类型 | 基准时间 | 备注 |
 * |------|---------|------|
 * | bugfix | 15-30分钟 | 取决于复现难度 |
 *
 * ## 经验规则
 * 1. **涉及认证/安全的任务** → 基准时间 × 1.5
 * ```
 *
 * @module task/eta-rules-manager
 * @see https://github.com/hs3180/disclaude/issues/1234
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ETARulesManager');

/** Default content for a new eta-rules.md file */
const DEFAULT_CONTENT = `# ETA 估计规则

> 此文件维护从历史任务中学到的估计规则，可随经验积累进化。
> 格式为自由 Markdown，Agent 和用户均可编辑。

## 任务类型基准时间

| 类型 | 基准时间 | 备注 |
|------|---------|------|
| bugfix | 15-30分钟 | 取决于复现难度 |
| feature-small | 30-60分钟 | 单一功能点 |
| feature-medium | 2-4小时 | 需要多个组件配合 |
| refactoring | 视范围而定 | 需要评估影响面 |
| documentation | 15-30分钟 | 取决于范围 |
| testing | 30-60分钟 | 取决于覆盖范围 |
| investigation | 30-60分钟 | 取决于问题复杂度 |

## 经验规则

1. **涉及认证/安全的任务** → 基准时间 × 1.5
2. **需要修改核心模块** → 基准时间 × 2
3. **有现成参考代码** → 基准时间 × 0.7
4. **涉及第三方 API 集成** → 基准时间 × 1.5 + 调试时间

## 历史偏差分析

- 低估场景: 涉及异步逻辑、状态管理、多组件协调
- 高估场景: 简单的 CRUD 操作、有清晰参考的重复性工作

`;

/**
 * Manages ETA estimation rules stored as Markdown.
 *
 * Provides methods to read, update, and append rules.
 * The rules file evolves over time with new experience.
 */
export class ETARulesManager {
  private readonly rulesFilePath: string;
  private initialized = false;

  /**
   * Create an ETARulesManager.
   *
   * @param workspaceDir - Workspace directory (rules stored in `.claude/` subdirectory)
   */
  constructor(workspaceDir: string) {
    this.rulesFilePath = path.join(workspaceDir, '.claude', 'eta-rules.md');
  }

  /**
   * Ensure the rules file exists with default content.
   * Called lazily before first read/write operation.
   */
  private async ensureFile(): Promise<void> {
    if (this.initialized) {return;}

    const dir = path.dirname(this.rulesFilePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {
      // Directory may already exist
    }

    try {
      await fs.access(this.rulesFilePath);
    } catch {
      // File doesn't exist, create with defaults
      try {
        await fs.writeFile(this.rulesFilePath, DEFAULT_CONTENT, 'utf-8');
        logger.info({ path: this.rulesFilePath }, 'ETA rules file created with defaults');
      } catch (error) {
        logger.error({ err: error, path: this.rulesFilePath }, 'Failed to create ETA rules file');
        throw error;
      }
    }

    this.initialized = true;
  }

  /**
   * Read the full content of the rules file.
   *
   * @returns Full Markdown content of eta-rules.md
   */
  async getRules(): Promise<string> {
    await this.ensureFile();

    try {
      return await fs.readFile(this.rulesFilePath, 'utf-8');
    } catch (error) {
      logger.error({ err: error }, 'Failed to read ETA rules');
      throw error;
    }
  }

  /**
   * Append a new experience rule to the rules file.
   *
   * @param rule - The rule text to append (should be a numbered item)
   * @param section - Optional section name to append under (defaults to "经验规则")
   */
  async appendRule(rule: string, section = '经验规则'): Promise<void> {
    await this.ensureFile();

    try {
      const content = await fs.readFile(this.rulesFilePath, 'utf-8');
      const updated = this.appendToSection(content, section, rule);
      await fs.writeFile(this.rulesFilePath, updated, 'utf-8');
      logger.info({ section, rule }, 'ETA rule appended');
    } catch (error) {
      logger.error({ err: error, section, rule }, 'Failed to append ETA rule');
      throw error;
    }
  }

  /**
   * Append text content to a specific Markdown section.
   *
   * Finds the section header and appends content before the next
   * `## ` header or end of file.
   */
  private appendToSection(content: string, sectionName: string, text: string): string {
    const lines = content.split('\n');
    let sectionFound = false;
    let insertIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line === `## ${sectionName}` || line === `## ${sectionName}`) {
        sectionFound = true;
        continue;
      }

      if (sectionFound && line.startsWith('## ')) {
        // Found the next section - insert before it
        insertIndex = i;
        break;
      }
    }

    if (!sectionFound) {
      // Section doesn't exist, append at end
      return `${content  }\n## ${sectionName}\n\n${text}\n`;
    }

    if (insertIndex === -1) {
      // We're at the last section - append at end
      return `${content  }\n${text}\n`;
    }

    // Insert before the next section
    lines.splice(insertIndex, 0, text);
    return lines.join('\n');
  }

  /**
   * Add a new "最近更新" entry to track rule changes.
   *
   * @param description - Description of what was updated
   */
  async addUpdateLog(description: string): Promise<void> {
    const [date] = new Date().toISOString().split('T');
    const entry = `- ${date}: ${description}`;

    await this.appendRule(entry, '最近更新');
  }

  /**
   * Get the file path for the rules file.
   *
   * Useful for debugging or for passing to other tools.
   */
  getRulesFilePath(): string {
    return this.rulesFilePath;
  }

  /**
   * Reset the initialization state (for testing).
   */
  resetInitialization(): void {
    this.initialized = false;
  }
}
