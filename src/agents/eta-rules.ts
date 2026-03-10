/**
 * ETA Rules - Markdown-based estimation rules for task time prediction.
 *
 * Issue #1234: Task ETA Estimation System
 *
 * Maintains a Markdown file with estimation rules that can evolve over time.
 * Rules are written in natural language for LLM understanding.
 *
 * @module agents/eta-rules
 */

import { createLogger } from '../utils/logger.js';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';

const logger = createLogger('ETARules');

/**
 * Rule update entry for adding new rules.
 */
export interface RuleUpdate {
  /** Category of the rule */
  category: 'baseline' | 'multiplier' | 'experience' | 'bias';
  /** The rule content in natural language */
  rule: string;
  /** Source of this rule (e.g., "来自 2024-03-10 登录模块重构的经验") */
  source: string;
}

/**
 * ETA Rules Manager.
 *
 * Manages eta-rules.md file with estimation rules.
 */
export class ETARules {
  private readonly rulesFile: string;
  private initialized = false;

  constructor() {
    const workspaceDir = process.env.WORKSPACE_DIR || process.cwd();
    const claudeDir = resolve(workspaceDir, '.claude');
    this.rulesFile = join(claudeDir, 'eta-rules.md');
  }

  /**
   * Initialize storage - ensure directory and file exist.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const claudeDir = resolve(this.rulesFile, '..');
      await fs.mkdir(claudeDir, { recursive: true });

      // Check if file exists, create with template if not
      try {
        await fs.access(this.rulesFile);
      } catch {
        await this.createInitialFile();
      }

      this.initialized = true;
      logger.info({ file: this.rulesFile }, 'ETA rules initialized');
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize ETA rules');
      throw error;
    }
  }

  /**
   * Create initial eta-rules.md with template.
   */
  private async createInitialFile(): Promise<void> {
    const template = `# ETA 估计规则

此文件维护任务时间估计的规则，随经验积累不断进化。

## 任务类型基准时间

| 类型 | 基准时间 | 备注 |
|------|---------|------|
| bugfix | 15-30分钟 | 取决于复现难度 |
| feature-small | 30-60分钟 | 单一功能点 |
| feature-medium | 2-4小时 | 需要多个组件配合 |
| feature-large | 4-8小时 | 涉及架构调整 |
| refactoring | 视范围而定 | 需要评估影响面 |
| documentation | 15-30分钟 | 纯文档工作 |
| testing | 30-60分钟 | 包含测试用例编写 |

## 经验规则

1. **涉及认证/安全的任务** → 基准时间 × 1.5
2. **需要修改核心模块** → 基准时间 × 2
3. **有现成参考代码** → 基准时间 × 0.7
4. **涉及第三方 API 集成** → 基准时间 × 1.5 + 调试时间
5. **需要数据库迁移** → 基准时间 × 1.3
6. **跨平台/多端适配** → 基准时间 × 1.5

## 历史偏差分析

### 低估场景
- 涉及异步逻辑、状态管理
- 需要处理边界情况
- 依赖外部服务的调试

### 高估场景
- 简单的 CRUD 操作
- 有成熟的代码模板
- 纯配置修改

## 最近更新

- 初始化 ETA 规则文档

---

*此文档会根据任务执行经验自动更新*
`;

    await fs.writeFile(this.rulesFile, template, 'utf-8');
  }

  /**
   * Read all rules as raw Markdown.
   */
  async readRules(): Promise<string> {
    await this.ensureInitialized();
    return fs.readFile(this.rulesFile, 'utf-8');
  }

  /**
   * Add a new rule to the document.
   */
  async addRule(update: RuleUpdate): Promise<void> {
    await this.ensureInitialized();

    const content = await this.readRules();
    const date = new Date().toISOString().split('T')[0];

    let sectionContent = '';
    let insertPoint = content.indexOf('## 最近更新');

    switch (update.category) {
      case 'baseline':
        // Add to task type baseline table (would need more complex parsing)
        sectionContent = `\n### 新基准 (${date})\n${update.rule}\n- 来源: ${update.source}\n`;
        break;

      case 'multiplier':
        // Add to experience rules
        const expMatch = content.match(/## 经验规则\n/);
        if (expMatch && expMatch.index) {
          const afterHeader = content.slice(expMatch.index + expMatch[0].length);
          const nextSection = afterHeader.indexOf('\n## ');
          const ruleNumber = (content.match(/^\d+\./gm) || []).length + 1;
          const newRule = `${ruleNumber}. **${update.rule}**\n`;
          // Insert after existing rules in experience section
          insertPoint = expMatch.index + expMatch[0].length + (nextSection > 0 ? nextSection : 0);
        }
        sectionContent = `\n${update.rule}\n- 来源: ${update.source}\n`;
        break;

      case 'experience':
      case 'bias':
        // Add to bias analysis
        const biasMatch = content.match(/### 高估场景\n/);
        if (biasMatch && biasMatch.index) {
          insertPoint = biasMatch.index;
        }
        sectionContent = `\n### ${date} 新发现\n${update.rule}\n- 来源: ${update.source}\n`;
        break;
    }

    // Update "最近更新" section
    const updateEntry = `- ${date}: ${update.rule} (${update.source})\n`;
    const updatedContent = content.replace(
      /## 最近更新\n/,
      `## 最近更新\n${updateEntry}`
    );

    await fs.writeFile(this.rulesFile, updatedContent, 'utf-8');
    logger.info({ category: update.category, rule: update.rule }, 'Added new ETA rule');
  }

  /**
   * Update the rules based on task execution patterns.
   * This is called periodically to learn from task records.
   */
  async updateFromPatterns(patterns: {
    underEstimated: string[];
    overEstimated: string[];
    newRules: string[];
  }): Promise<void> {
    await this.ensureInitialized();

    const date = new Date().toISOString().split('T')[0];
    const content = await this.readRules();

    let updatedContent = content;

    // Add under-estimated patterns
    if (patterns.underEstimated.length > 0) {
      const newUnder = patterns.underEstimated.map(p => `- ${p}`).join('\n');
      updatedContent = updatedContent.replace(
        /### 低估场景\n/,
        `### 低估场景\n${newUnder}\n`
      );
    }

    // Add over-estimated patterns
    if (patterns.overEstimated.length > 0) {
      const newOver = patterns.overEstimated.map(p => `- ${p}`).join('\n');
      updatedContent = updatedContent.replace(
        /### 高估场景\n/,
        `### 高估场景\n${newOver}\n`
      );
    }

    // Update 最近更新
    if (patterns.newRules.length > 0) {
      const updates = patterns.newRules.map(r => `- ${date}: ${r}`).join('\n');
      updatedContent = updatedContent.replace(
        /## 最近更新\n/,
        `## 最近更新\n${updates}\n`
      );
    }

    await fs.writeFile(this.rulesFile, updatedContent, 'utf-8');
    logger.info({ patterns }, 'Updated ETA rules from patterns');
  }

  /**
   * Get file path for external access.
   */
  getFilePath(): string {
    return this.rulesFile;
  }

  /**
   * Ensure storage is initialized.
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}

/**
 * Global ETA rules instance.
 */
export const etaRules = new ETARules();
