/**
 * ETA File Utilities - Markdown file management for the ETA prediction system.
 *
 * Provides minimal file I/O utilities for the Markdown-based ETA system.
 * All actual reasoning, pattern analysis, and prediction is handled by the
 * eta-predictor Skill through LLM natural language processing.
 *
 * File locations:
 * - .claude/task-records.md - Historical task execution records
 * - .claude/eta-rules.md    - Evolving estimation rules
 *
 * @module task/eta-files
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ETAFiles');

/** Default content for task-records.md when first created. */
const DEFAULT_TASK_RECORDS = `# 任务执行记录

> 此文件记录每个任务的执行信息，用于 ETA 预估系统学习。
> 格式为非结构化 Markdown，随经验积累进化。

`;

/** Default content for eta-rules.md when first created. */
const DEFAULT_ETA_RULES = `# ETA 估计规则

## 任务类型基准时间

| 类型 | 基准时间 | 备注 |
|------|---------|------|
| bugfix | 15-60分钟 | 取决于复现难度和根因深度 |
| feature-small | 30-90分钟 | 单一功能点，无跨模块依赖 |
| feature-medium | 2-4小时 | 需要多个组件配合 |
| refactoring | 视范围而定 | 需要评估影响面 |
| docs | 15-30分钟 | 纯文档编写 |
| test | 30-60分钟 | 单元测试，含边界情况 |
| research | 1-3小时 | 需要调研多个方案 |
| chore | 10-30分钟 | 配置、依赖更新等 |

## 经验规则

1. **涉及认证/安全的任务** → 基准时间 × 1.5
2. **需要修改核心模块** → 基准时间 × 2
3. **有现成参考代码** → 基准时间 × 0.7
4. **涉及第三方 API 集成** → 基准时间 × 1.5 + 调试时间
5. **跨多文件/多模块修改** → 基准时间 × 1.3
6. **需要理解复杂业务逻辑** → 基准时间 × 1.5
7. **第一次做某类任务** → 基准时间 × 1.5（学习曲线）
8. **有完整测试覆盖要求** → 基准时间 × 1.3

## 低估高发场景

- 涉及异步逻辑和状态管理
- 表面 bug 实际是架构问题
- 需要处理多种边界情况
- 跨平台/跨浏览器兼容性
- 涉及数据迁移或格式转换

## 高估高发场景

- 简单的 CRUD 操作
- 有现成模板可参考的任务
- 配置修改类任务
- 纯文本/样式调整

## 最近更新

- 初始规则创建
`;

/**
 * Get the path to the task-records.md file.
 *
 * @param workspaceDir - Workspace directory path
 * @returns Absolute path to .claude/task-records.md
 */
export function getTaskRecordsPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.claude', 'task-records.md');
}

/**
 * Get the path to the eta-rules.md file.
 *
 * @param workspaceDir - Workspace directory path
 * @returns Absolute path to .claude/eta-rules.md
 */
export function getEtaRulesPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.claude', 'eta-rules.md');
}

/**
 * Get the .claude directory path.
 *
 * @param workspaceDir - Workspace directory path
 * @returns Absolute path to .claude directory
 */
export function getClaudeDir(workspaceDir: string): string {
  return path.join(workspaceDir, '.claude');
}

/**
 * Ensure the .claude directory and ETA files exist.
 * Creates them with default content if they don't exist.
 *
 * @param workspaceDir - Workspace directory path
 */
export async function ensureEtaFiles(workspaceDir: string): Promise<void> {
  const claudeDir = getClaudeDir(workspaceDir);
  const recordsPath = getTaskRecordsPath(workspaceDir);
  const rulesPath = getEtaRulesPath(workspaceDir);

  try {
    await fs.mkdir(claudeDir, { recursive: true });
  } catch (error) {
    logger.error({ err: error, claudeDir }, 'Failed to create .claude directory');
    throw error;
  }

  // Create task-records.md if it doesn't exist
  try {
    await fs.access(recordsPath);
  } catch {
    await fs.writeFile(recordsPath, DEFAULT_TASK_RECORDS, 'utf-8');
    logger.info({ path: recordsPath }, 'Created default task-records.md');
  }

  // Create eta-rules.md if it doesn't exist
  try {
    await fs.access(rulesPath);
  } catch {
    await fs.writeFile(rulesPath, DEFAULT_ETA_RULES, 'utf-8');
    logger.info({ path: rulesPath }, 'Created default eta-rules.md');
  }
}

/**
 * Read the contents of task-records.md.
 *
 * @param workspaceDir - Workspace directory path
 * @returns Content of task-records.md, or empty string if not found
 */
export async function readTaskRecords(workspaceDir: string): Promise<string> {
  const recordsPath = getTaskRecordsPath(workspaceDir);

  try {
    return await fs.readFile(recordsPath, 'utf-8');
  } catch (error) {
    logger.debug({ err: error }, 'task-records.md not found or unreadable');
    return '';
  }
}

/**
 * Read the contents of eta-rules.md.
 *
 * @param workspaceDir - Workspace directory path
 * @returns Content of eta-rules.md, or empty string if not found
 */
export async function readEtaRules(workspaceDir: string): Promise<string> {
  const rulesPath = getEtaRulesPath(workspaceDir);

  try {
    return await fs.readFile(rulesPath, 'utf-8');
  } catch (error) {
    logger.debug({ err: error }, 'eta-rules.md not found or unreadable');
    return '';
  }
}

/**
 * Append a task record to task-records.md.
 * The record should be a Markdown-formatted string.
 *
 * @param workspaceDir - Workspace directory path
 * @param record - Markdown-formatted task record to append
 */
export async function appendTaskRecord(workspaceDir: string, record: string): Promise<void> {
  const recordsPath = getTaskRecordsPath(workspaceDir);

  try {
    // Ensure file exists before appending
    await ensureEtaFiles(workspaceDir);

    // Append with a newline separator
    await fs.appendFile(recordsPath, record + '\n', 'utf-8');
    logger.info({ path: recordsPath }, 'Task record appended to task-records.md');
  } catch (error) {
    logger.error({ err: error }, 'Failed to append task record');
    throw error;
  }
}

/**
 * Update eta-rules.md with new content.
 * This replaces the entire file content.
 *
 * @param workspaceDir - Workspace directory path
 * @param content - New Markdown content for eta-rules.md
 */
export async function updateEtaRules(workspaceDir: string, content: string): Promise<void> {
  const rulesPath = getEtaRulesPath(workspaceDir);

  try {
    await ensureEtaFiles(workspaceDir);
    await fs.writeFile(rulesPath, content, 'utf-8');
    logger.info({ path: rulesPath }, 'eta-rules.md updated');
  } catch (error) {
    logger.error({ err: error }, 'Failed to update eta-rules.md');
    throw error;
  }
}
