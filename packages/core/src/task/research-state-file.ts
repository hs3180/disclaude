/**
 * ResearchStateFile - RESEARCH.md 研究状态文件管理器
 *
 * 在 Research 模式中，自动维护研究过程中的状态信息。
 * RESEARCH.md 文件位于研究工作目录下（workspace/research/{topic}/RESEARCH.md），
 * 由 agent 在每次研究交互后自动更新。
 *
 * 文件结构:
 * ```
 * # 研究主题
 *
 * ## 研究目标
 * - [ ] 目标 1
 * - [ ] 目标 2
 *
 * ## 已收集的信息
 * ### 发现 1
 * - 来源：...
 * - 关键内容：...
 *
 * ## 待调查的问题
 * - [ ] 问题 1
 *
 * ## 研究结论
 * （研究完成后填写）
 *
 * ## 相关资源
 * - [资源名称](链接)
 * ```
 *
 * @module task/research-state-file
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ResearchStateFile');

/**
 * 研究发现条目
 */
export interface ResearchFinding {
  /** 发现标题 */
  title: string;
  /** 信息来源 */
  source: string;
  /** 关键内容描述 */
  content: string;
  /** 发现时间（ISO 8601） */
  timestamp?: string;
}

/**
 * 待调查问题条目
 */
export interface ResearchQuestion {
  /** 问题描述 */
  question: string;
  /** 是否已解决 */
  resolved: boolean;
  /** 解决方案（已解决时） */
  resolution?: string;
}

/**
 * 相关资源条目
 */
export interface ResearchResource {
  /** 资源名称 */
  name: string;
  /** 资源链接 */
  url: string;
}

/**
 * RESEARCH.md 文件的完整数据模型
 */
export interface ResearchState {
  /** 研究主题 */
  topic: string;
  /** 研究描述/背景 */
  description: string;
  /** 研究目标列表 */
  goals: string[];
  /** 已收集的发现列表 */
  findings: ResearchFinding[];
  /** 待调查的问题列表 */
  questions: ResearchQuestion[];
  /** 研究结论（可选，完成时填写） */
  conclusion?: string;
  /** 相关资源列表 */
  resources: ResearchResource[];
  /** 创建时间 */
  createdAt: string;
  /** 最后更新时间 */
  updatedAt: string;
}

/**
 * ResearchStateFile 初始化配置
 */
export interface ResearchStateFileConfig {
  /** Workspace 根目录（研究目录的父目录） */
  workspaceDir: string;
  /** 可选：自定义研究子目录名称（默认: 'research'） */
  researchSubdir?: string;
}

/**
 * RESEARCH.md 研究状态文件管理器
 *
 * 提供结构化的 API 来管理研究过程中的状态信息。
 * 所有状态变更都通过方法调用触发，内部自动维护 Markdown 格式的 RESEARCH.md 文件。
 *
 * @example
 * ```typescript
 * const rsf = new ResearchStateFile({ workspaceDir: '/workspace' });
 *
 * // 初始化研究
 * await rsf.initialize({
 *   topic: 'ai-safety',
 *   description: '研究 AI 安全领域的最新进展',
 *   goals: ['了解 RLHF 训练方法', '分析对齐技术']
 * });
 *
 * // 添加发现
 * await rsf.addFinding({
 *   title: 'RLHF 训练方法综述',
 *   source: 'https://arxiv.org/...',
 *   content: '基于人类反馈的强化学习...'
 * });
 *
 * // 添加待调查问题
 * await rsf.addQuestion('Constitutional AI 与 RLHF 的区别是什么？');
 *
 * // 解决问题
 * await rsf.resolveQuestion('Constitutional AI 与 RLHF 的区别是什么？', 'CAI 使用 AI 反馈...');
 *
 * // 生成结论
 * await rsf.setConclusion('研究发现...');
 * ```
 */
export class ResearchStateFile {
  private readonly workspaceDir: string;
  private readonly researchBaseDir: string;
  private readonly fileName = 'RESEARCH.md';

  constructor(config: ResearchStateFileConfig) {
    this.workspaceDir = config.workspaceDir;
    this.researchBaseDir = config.researchSubdir
      ? path.join(this.workspaceDir, config.researchSubdir)
      : path.join(this.workspaceDir, 'research');
  }

  /**
   * 获取指定研究主题的目录路径
   *
   * @param topic - 研究主题（会经过安全处理）
   * @returns 研究目录的绝对路径
   */
  getResearchDir(topic: string): string {
    return path.join(this.researchBaseDir, sanitizeTopic(topic));
  }

  /**
   * 获取指定研究主题的 RESEARCH.md 文件路径
   *
   * @param topic - 研究主题
   * @returns RESEARCH.md 文件的绝对路径
   */
  getFilePath(topic: string): string {
    return path.join(this.getResearchDir(topic), this.fileName);
  }

  /**
   * 检查指定研究主题的 RESEARCH.md 是否已存在
   *
   * @param topic - 研究主题
   * @returns 文件是否存在
   */
  async exists(topic: string): Promise<boolean> {
    const filePath = this.getFilePath(topic);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 初始化研究状态文件
   *
   * 创建研究目录和 RESEARCH.md 模板文件。如果文件已存在则抛出错误。
   *
   * @param params - 初始化参数
   * @param params.topic - 研究主题
   * @param params.description - 研究描述/背景
   * @param params.goals - 研究目标列表
   * @throws 如果 RESEARCH.md 已存在
   */
  async initialize(params: {
    topic: string;
    description: string;
    goals: string[];
  }): Promise<void> {
    const { topic, description, goals } = params;

    if (await this.exists(topic)) {
      throw new Error(
        `RESEARCH.md already exists for topic "${topic}" at ${this.getFilePath(topic)}`
      );
    }

    const now = new Date().toISOString();
    const state: ResearchState = {
      topic,
      description,
      goals,
      findings: [],
      questions: [],
      resources: [],
      createdAt: now,
      updatedAt: now,
    };

    const researchDir = this.getResearchDir(topic);
    await fs.mkdir(researchDir, { recursive: true });
    await this.writeState(topic, state);

    logger.info(
      { topic, researchDir },
      'Research state file initialized'
    );
  }

  /**
   * 读取当前研究状态
   *
   * @param topic - 研究主题
   * @returns 完整的研究状态数据
   * @throws 如果 RESEARCH.md 不存在或格式无效
   */
  async readState(topic: string): Promise<ResearchState> {
    const content = await this.readRaw(topic);
    return parseResearchMd(content);
  }

  /**
   * 读取 RESEARCH.md 的原始 Markdown 内容
   *
   * @param topic - 研究主题
   * @returns Markdown 文本内容
   */
  async readRaw(topic: string): Promise<string> {
    const filePath = this.getFilePath(topic);
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      logger.error({ err: error, topic }, 'Failed to read RESEARCH.md');
      throw new Error(
        `RESEARCH.md not found for topic "${topic}" at ${filePath}`
      );
    }
  }

  /**
   * 添加研究发现
   *
   * 将新发现追加到"已收集的信息"章节。
   *
   * @param topic - 研究主题
   * @param finding - 研究发现条目
   */
  async addFinding(
    topic: string,
    finding: Omit<ResearchFinding, 'timestamp'>
  ): Promise<void> {
    const state = await this.readState(topic);
    state.findings.push({
      ...finding,
      timestamp: new Date().toISOString(),
    });
    state.updatedAt = new Date().toISOString();
    await this.writeState(topic, state);

    logger.debug(
      { topic, findingTitle: finding.title },
      'Finding added to research state'
    );
  }

  /**
   * 添加待调查问题
   *
   * 将新问题追加到"待调查的问题"章节。
   *
   * @param topic - 研究主题
   * @param question - 问题描述
   */
  async addQuestion(topic: string, question: string): Promise<void> {
    const state = await this.readState(topic);

    // 避免重复添加相同问题
    if (state.questions.some((q) => q.question === question)) {
      logger.debug(
        { topic, question },
        'Question already exists, skipping'
      );
      return;
    }

    state.questions.push({ question, resolved: false });
    state.updatedAt = new Date().toISOString();
    await this.writeState(topic, state);

    logger.debug({ topic, question }, 'Question added to research state');
  }

  /**
   * 解决待调查问题
   *
   * 将问题标记为已解决，并记录解决方案。
   *
   * @param topic - 研究主题
   * @param question - 问题描述
   * @param resolution - 解决方案
   * @throws 如果问题不存在
   */
  async resolveQuestion(
    topic: string,
    question: string,
    resolution: string
  ): Promise<void> {
    const state = await this.readState(topic);
    const target = state.questions.find((q) => q.question === question);

    if (!target) {
      throw new Error(
        `Question not found: "${question}" in topic "${topic}"`
      );
    }

    if (target.resolved) {
      logger.debug(
        { topic, question },
        'Question already resolved, skipping'
      );
      return;
    }

    target.resolved = true;
    target.resolution = resolution;

    // 将已解决的问题转为发现
    state.findings.push({
      title: `已解决: ${question}`,
      source: '问题解决',
      content: resolution,
      timestamp: new Date().toISOString(),
    });

    state.updatedAt = new Date().toISOString();
    await this.writeState(topic, state);

    logger.debug(
      { topic, question },
      'Question resolved and moved to findings'
    );
  }

  /**
   * 添加相关资源
   *
   * @param topic - 研究主题
   * @param resource - 资源条目
   */
  async addResource(
    topic: string,
    resource: ResearchResource
  ): Promise<void> {
    const state = await this.readState(topic);

    // 避免重复添加相同资源
    if (state.resources.some((r) => r.url === resource.url)) {
      logger.debug(
        { topic, url: resource.url },
        'Resource already exists, skipping'
      );
      return;
    }

    state.resources.push(resource);
    state.updatedAt = new Date().toISOString();
    await this.writeState(topic, state);

    logger.debug(
      { topic, resourceName: resource.name },
      'Resource added to research state'
    );
  }

  /**
   * 设置研究结论
   *
   * @param topic - 研究主题
   * @param conclusion - 研究结论内容
   */
  async setConclusion(topic: string, conclusion: string): Promise<void> {
    const state = await this.readState(topic);
    state.conclusion = conclusion;
    state.updatedAt = new Date().toISOString();
    await this.writeState(topic, state);

    logger.info({ topic }, 'Research conclusion set');
  }

  /**
   * 完成研究并归档
   *
   * 生成最终的研究摘要，并将 RESEARCH.md 标记为完成。
   *
   * @param topic - 研究主题
   * @param conclusion - 研究结论（可选，如果不提供则自动生成摘要）
   * @returns 更新后的研究状态
   */
  async complete(
    topic: string,
    conclusion?: string
  ): Promise<ResearchState> {
    const state = await this.readState(topic);

    if (!conclusion) {
      conclusion = generateAutoSummary(state);
    }

    state.conclusion = conclusion;
    state.updatedAt = new Date().toISOString();
    await this.writeState(topic, state);

    logger.info(
      { topic, findingCount: state.findings.length, questionCount: state.questions.length },
      'Research completed and archived'
    );

    return state;
  }

  /**
   * 删除研究状态文件
   *
   * @param topic - 研究主题
   * @param options - 选项
   * @param options.deleteDir - 是否同时删除整个研究目录（默认: false）
   */
  async cleanup(
    topic: string,
    options: { deleteDir?: boolean } = {}
  ): Promise<void> {
    const researchDir = this.getResearchDir(topic);

    if (options.deleteDir) {
      await fs.rm(researchDir, { recursive: true, force: true });
      logger.info({ topic, researchDir }, 'Research directory cleaned up');
    } else {
      const filePath = this.getFilePath(topic);
      await fs.rm(filePath, { force: true });
      logger.info({ topic }, 'RESEARCH.md cleaned up');
    }
  }

  /**
   * 列出所有研究主题
   *
   * @returns 已存在 RESEARCH.md 的研究主题列表
   */
  async listTopics(): Promise<string[]> {
    try {
      await fs.access(this.researchBaseDir);
    } catch {
      return [];
    }

    try {
      const entries = await fs.readdir(this.researchBaseDir, {
        withFileTypes: true,
      });
      const topics: string[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const researchFile = path.join(
            this.researchBaseDir,
            entry.name,
            this.fileName
          );
          try {
            await fs.access(researchFile);
            topics.push(entry.name);
          } catch {
            // 目录存在但没有 RESEARCH.md，跳过
          }
        }
      }

      return topics.sort();
    } catch (error) {
      logger.error({ err: error }, 'Failed to list research topics');
      return [];
    }
  }

  /**
   * 将研究状态序列化为 Markdown 格式并写入文件
   */
  private async writeState(topic: string, state: ResearchState): Promise<void> {
    const markdown = serializeToMarkdown(state);
    const filePath = this.getFilePath(topic);

    try {
      await fs.writeFile(filePath, markdown, 'utf-8');
    } catch (error) {
      logger.error({ err: error, topic }, 'Failed to write RESEARCH.md');
      throw error;
    }
  }
}

// ============================================================================
// Markdown 序列化 / 反序列化
// ============================================================================

/**
 * 将研究状态序列化为 Markdown 格式
 */
function serializeToMarkdown(state: ResearchState): string {
  const lines: string[] = [];

  // 标题和描述
  lines.push(`# ${state.topic}`);
  lines.push('');
  if (state.description) {
    lines.push(`> ${state.description}`);
    lines.push('');
  }

  // 研究目标
  lines.push('## 研究目标');
  lines.push('');
  if (state.goals.length === 0) {
    lines.push('_（暂无研究目标）_');
  } else {
    for (const goal of state.goals) {
      lines.push(`- [ ] ${goal}`);
    }
  }
  lines.push('');

  // 已收集的信息
  lines.push('## 已收集的信息');
  lines.push('');
  if (state.findings.length === 0) {
    lines.push('_（暂无发现）_');
  } else {
    for (let i = 0; i < state.findings.length; i++) {
      const finding = state.findings[i];
      lines.push(`### 发现 ${i + 1}: ${finding.title}`);
      if (finding.timestamp) {
        lines.push(`- ⏰ 时间：${finding.timestamp}`);
      }
      lines.push(`- 📌 来源：${finding.source}`);
      lines.push(`- 📝 关键内容：${finding.content}`);
      lines.push('');
    }
  }

  // 待调查的问题
  lines.push('## 待调查的问题');
  lines.push('');
  const unresolved = state.questions.filter((q) => !q.resolved);
  const resolved = state.questions.filter((q) => q.resolved);
  if (unresolved.length === 0 && resolved.length === 0) {
    lines.push('_（暂无待调查问题）_');
  } else {
    for (const q of unresolved) {
      lines.push(`- [ ] ${q.question}`);
    }
    if (resolved.length > 0) {
      lines.push('');
      lines.push('<details>');
      lines.push('<summary>✅ 已解决的问题</summary>');
      lines.push('');
      for (const q of resolved) {
        lines.push(`- [x] ${q.question}`);
        if (q.resolution) {
          lines.push(`  - ${q.resolution}`);
        }
      }
      lines.push('');
      lines.push('</details>');
    }
  }
  lines.push('');

  // 研究结论
  lines.push('## 研究结论');
  lines.push('');
  if (state.conclusion) {
    lines.push(state.conclusion);
  } else {
    lines.push('_（研究完成后填写）_');
  }
  lines.push('');

  // 相关资源
  lines.push('## 相关资源');
  lines.push('');
  if (state.resources.length === 0) {
    lines.push('_（暂无相关资源）_');
  } else {
    for (const resource of state.resources) {
      lines.push(`- [${resource.name}](${resource.url})`);
    }
  }
  lines.push('');

  // 元数据
  lines.push('---');
  lines.push(`- 创建时间：${state.createdAt}`);
  lines.push(`- 最后更新：${state.updatedAt}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * 从 Markdown 内容解析研究状态
 *
 * 采用宽松的解析策略，确保即使格式略有变化也能正确读取。
 */
function parseResearchMd(markdown: string): ResearchState {
  const lines = markdown.split('\n');

  let topic = '';
  let description = '';
  const goals: string[] = [];
  const findings: ResearchFinding[] = [];
  const questions: ResearchQuestion[] = [];
  let conclusion = '';
  const resources: ResearchResource[] = [];
  let createdAt = '';
  let updatedAt = '';

  let currentSection: string | null = null;
  let currentFinding: Partial<ResearchFinding> | null = null;

  const parseMetadata = (line: string): void => {
    const timeMatch = line.match(/[-*]\s*创建时间[：:]\s*(.+)/);
    if (timeMatch) {
      createdAt = timeMatch[1].trim();
    }
    const updateMatch = line.match(/[-*]\s*最后更新[：:]\s*(.+)/);
    if (updateMatch) {
      updatedAt = updateMatch[1].trim();
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 标题
    if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
      topic = trimmed.substring(2).trim();
      currentSection = null;
      continue;
    }

    // 章节标题
    if (trimmed.startsWith('## ')) {
      // 保存当前 finding
      if (currentFinding && currentFinding.title) {
        findings.push({
          title: currentFinding.title,
          source: currentFinding.source ?? '',
          content: currentFinding.content ?? '',
          timestamp: currentFinding.timestamp,
        });
        currentFinding = null;
      }

      const sectionText = trimmed.substring(3).trim();
      if (sectionText === '研究目标') {
        currentSection = 'goals';
      } else if (sectionText === '已收集的信息') {
        currentSection = 'findings';
      } else if (sectionText === '待调查的问题') {
        currentSection = 'questions';
      } else if (sectionText === '研究结论') {
        currentSection = 'conclusion';
      } else if (sectionText === '相关资源') {
        currentSection = 'resources';
      } else {
        currentSection = null;
      }
      continue;
    }

    // 发现子标题
    if (
      currentSection === 'findings' &&
      trimmed.startsWith('### ') &&
      !trimmed.startsWith('<details>') &&
      !trimmed.startsWith('<summary>')
    ) {
      // 保存上一个 finding
      if (currentFinding && currentFinding.title) {
        findings.push({
          title: currentFinding.title,
          source: currentFinding.source ?? '',
          content: currentFinding.content ?? '',
          timestamp: currentFinding.timestamp,
        });
      }
      // 解析 "### 发现 N: 标题" 格式
      const findingMatch = trimmed.match(/^###\s+发现\s+\d+[：:]\s*(.+)/);
      currentFinding = {
        title: findingMatch ? findingMatch[1].trim() : trimmed.substring(4).trim(),
      };
      continue;
    }

    // 元数据分隔线
    if (trimmed === '---') {
      currentSection = 'metadata';
      if (currentFinding && currentFinding.title) {
        findings.push({
          title: currentFinding.title,
          source: currentFinding.source ?? '',
          content: currentFinding.content ?? '',
          timestamp: currentFinding.timestamp,
        });
        currentFinding = null;
      }
      continue;
    }

    // 跳过 HTML 开标签和空行（但保留 details 块内的内容行）
    if (
      (trimmed.startsWith('<') && !trimmed.startsWith('</')) ||
      trimmed === '' ||
      trimmed === '</details>'
    ) {
      continue;
    }

    // 根据当前 section 解析内容
    switch (currentSection) {
      case null: {
        // 描述（blockquote）
        if (trimmed.startsWith('> ')) {
          description = trimmed.substring(2).trim();
        }
        break;
      }
      case 'goals': {
        const goalMatch = trimmed.match(/^- \[.\] (.+)/);
        if (goalMatch) {
          goals.push(goalMatch[1].trim());
        }
        break;
      }
      case 'findings': {
        if (currentFinding) {
          if (trimmed.startsWith('- ⏰ 时间：') || trimmed.startsWith('- ⏰ 时间:')) {
            currentFinding.timestamp = trimmed.substring(trimmed.indexOf('：') !== -1 ? trimmed.indexOf('：') + 1 : trimmed.indexOf(':') + 1).trim();
          } else if (trimmed.startsWith('- 📌 来源：') || trimmed.startsWith('- 📌 来源:')) {
            currentFinding.source = trimmed.substring(trimmed.indexOf('：') !== -1 ? trimmed.indexOf('：') + 1 : trimmed.indexOf(':') + 1).trim();
          } else if (trimmed.startsWith('- 📝 关键内容：') || trimmed.startsWith('- 📝 关键内容:')) {
            currentFinding.content = trimmed.substring(trimmed.indexOf('：') !== -1 ? trimmed.indexOf('：') + 1 : trimmed.indexOf(':') + 1).trim();
          }
        }
        break;
      }
      case 'questions': {
        const questionMatch = trimmed.match(/^- \[([ xX])\] (.+)/);
        if (questionMatch) {
          const resolved = questionMatch[1] !== ' ';
          questions.push({
            question: questionMatch[2].trim(),
            resolved,
          });
        } else if (
          trimmed.startsWith('- ') &&
          questions.length > 0
        ) {
          // Resolution line under a resolved question
          const lastQuestion = questions[questions.length - 1];
          if (lastQuestion.resolved && !lastQuestion.resolution) {
            lastQuestion.resolution = trimmed.substring(2).trim();
          }
        }
        break;
      }
      case 'conclusion': {
        if (trimmed.startsWith('_（') || trimmed.startsWith('_(暂无')) {
          break;
        }
        conclusion += (conclusion ? '\n' : '') + trimmed;
        break;
      }
      case 'resources': {
        const resourceMatch = trimmed.match(
          /^- \[([^\]]+)\]\(([^)]+)\)$/
        );
        if (resourceMatch) {
          resources.push({
            name: resourceMatch[1].trim(),
            url: resourceMatch[2].trim(),
          });
        }
        break;
      }
      case 'metadata': {
        parseMetadata(trimmed);
        break;
      }
    }
  }

  // 保存最后一个 finding
  if (currentFinding && currentFinding.title) {
    findings.push({
      title: currentFinding.title,
      source: currentFinding.source ?? '',
      content: currentFinding.content ?? '',
      timestamp: currentFinding.timestamp,
    });
  }

  return {
    topic,
    description,
    goals,
    findings,
    questions,
    conclusion: conclusion.trim() || undefined,
    resources,
    createdAt,
    updatedAt,
  };
}

/**
 * 自动生成研究摘要
 */
function generateAutoSummary(state: ResearchState): string {
  const parts: string[] = [];

  const resolvedCount = state.questions.filter((q) => q.resolved).length;
  const unresolvedCount = state.questions.filter((q) => !q.resolved).length;

  parts.push(
    `本次研究围绕"${state.topic}"展开，共收集了 ${state.findings.length} 条发现。`
  );

  if (resolvedCount > 0 || unresolvedCount > 0) {
    parts.push(
      `调查了 ${state.questions.length} 个问题，其中 ${resolvedCount} 个已解决，${unresolvedCount} 个待深入。`
    );
  }

  if (state.resources.length > 0) {
    parts.push(`参考了 ${state.resources.length} 个相关资源。`);
  }

  return parts.join('');
}

/**
 * 安全化研究主题名称，使其可用作目录名
 *
 * @param topic - 原始研究主题
 * @returns 安全的目录名称
 */
export function sanitizeTopic(topic: string): string {
  return topic
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')        // 空格转连字符
    .replace(/[^a-z0-9\u4e00-\u9fff\-_]/g, '') // 仅保留字母、数字、中文、连字符、下划线
    .replace(/-+/g, '-')         // 多个连字符合并
    .replace(/^-|-$/g, '');      // 去除首尾连字符
}
