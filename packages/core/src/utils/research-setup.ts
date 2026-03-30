/**
 * Research workspace setup utility.
 *
 * Issue #1709: Research 模式 — SOUL + 工作目录 + Skill 套装切换
 *
 * Creates the research workspace structure:
 *   workspace/research/<topic>/
 *   ├── CLAUDE.md          # Research SOUL (behavior guidelines)
 *   └── .claude/
 *       └── skills/
 *           └── research-mode/
 *               └── SKILL.md  # Research-specific skill
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from './logger.js';
import { Config } from '../config/index.js';

const logger = createLogger('ResearchSetup');

/**
 * Result of setting up a research workspace.
 */
export interface ResearchSetupResult {
  /** Absolute path to the research working directory */
  researchCwd: string;
  /** Whether the directory was newly created */
  created: boolean;
}

/**
 * Research SOUL content (CLAUDE.md).
 *
 * This file acts as the "Research SOUL" - it provides behavioral guidelines
 * for the agent when operating in research mode.
 */
const RESEARCH_CLAUDE_MD = (topic: string) => `# Research Mode

> 研究主题: ${topic}

## 研究行为规范

### 目录限制
- 仅允许访问当前研究工作目录及其子目录
- 禁止访问 workspace 中的其他项目文件
- 禁止访问系统目录和其他路径

### 研究方法论
- 系统性地收集和整理信息
- 每个发现记录来源和关键内容
- 主动识别需要进一步调查的问题
- 使用结构化的方式组织研究发现

### 输出规范
- 使用 Markdown 格式记录研究发现
- 引用信息来源
- 对信息进行分类和优先级排序
- 定期总结研究进展

## 当前研究

### 研究目标
- [ ] 定义和细化研究问题
- [ ] 收集相关信息
- [ ] 分析和综合发现
- [ ] 形成结论

### 已收集的信息
（研究过程中自动更新）

### 待调查的问题
（研究过程中自动更新）

## 注意事项
- 保持客观，区分事实和观点
- 记录信息的不确定性
- 注意信息的时效性
`;

/**
 * Research-specific SKILL.md content.
 *
 * This skill is only loaded when in research mode,
 * providing research-specific guidance to the agent.
 */
const RESEARCH_SKILL_MD = `---
name: research-mode
description: Research mode behavior guidelines. Automatically activated when in research mode.
---

# Research Mode Guidelines

You are currently in **Research Mode**. Follow these guidelines:

## Core Principles
1. **Systematic Research**: Follow a structured approach to information gathering
2. **Source Citation**: Always cite the source of information
3. **Critical Thinking**: Evaluate the reliability and relevance of information
4. **Structured Output**: Organize findings in a clear, hierarchical format

## Workflow
1. **Define** the research question clearly
2. **Search** for relevant information using available tools
3. **Record** findings with source references
4. **Analyze** patterns and relationships in the data
5. **Synthesize** into coherent conclusions
6. **Report** findings in a structured format

## Directory Rules
- Only access files within the current research workspace
- Do not access other workspace projects or system directories
- Keep all research notes and files within the research directory

## Output Format
Use the following structure for research notes:
- **Source**: Where the information was found
- **Key Content**: Main points extracted
- **Relevance**: How it relates to the research question
- **Confidence**: How reliable the information is (high/medium/low)
`;

/**
 * Set up a research workspace for a given topic.
 *
 * Creates the directory structure and initializes:
 * - CLAUDE.md (Research SOUL) with research guidelines
 * - .claude/skills/research-mode/SKILL.md (Research skill)
 *
 * @param sanitizedTopic - Sanitized topic name for directory
 * @param originalTopic - Original topic text for display in CLAUDE.md
 * @returns Research setup result with cwd path
 */
export function setupResearchWorkspace(
  sanitizedTopic: string,
  originalTopic: string
): ResearchSetupResult {
  const workspaceDir = Config.getWorkspaceDir();
  const researchDir = path.join(workspaceDir, 'research', sanitizedTopic);

  // Create research directory structure
  const claudeDir = path.join(researchDir, '.claude');
  const skillsDir = path.join(claudeDir, 'skills');
  const researchSkillDir = path.join(skillsDir, 'research-mode');

  // Create directories synchronously (called from command handler)
  fs.mkdir(researchSkillDir, { recursive: true }).then(() => {
    logger.debug({ researchDir }, 'Research workspace directories created');

    // Write CLAUDE.md (Research SOUL)
    const claudeMdPath = path.join(researchDir, 'CLAUDE.md');
    fs.writeFile(claudeMdPath, RESEARCH_CLAUDE_MD(originalTopic), 'utf-8')
      .then(() => {
        logger.debug({ claudeMdPath }, 'Research CLAUDE.md created');
      })
      .catch((err) => {
        logger.error({ err, claudeMdPath }, 'Failed to create Research CLAUDE.md');
      });

    // Write research-mode SKILL.md
    const skillMdPath = path.join(researchSkillDir, 'SKILL.md');
    fs.writeFile(skillMdPath, RESEARCH_SKILL_MD, 'utf-8')
      .then(() => {
        logger.debug({ skillMdPath }, 'Research SKILL.md created');
      })
      .catch((err) => {
        logger.error({ err, skillMdPath }, 'Failed to create Research SKILL.md');
      });
  }).catch((err) => {
    logger.error({ err, researchDir }, 'Failed to create research workspace directories');
  });

  return {
    researchCwd: researchDir,
    created: true,
  };
}
