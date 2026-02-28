/**
 * Background Analyzer - Periodic analysis of user interactions.
 *
 * Runs scheduled analysis of chat history to detect patterns
 * and recommend scheduled tasks.
 *
 * Features:
 * - Cron-based scheduling
 * - Pattern detection from message history
 * - Integration with PatternStore for persistence
 * - Callback support for pattern notifications
 *
 * @see Issue #357 - Intelligent Scheduled Task Recommendation System
 */

import { CronJob } from 'cron';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../utils/logger.js';
import { Config } from '../config/index.js';
import { PatternStore } from './pattern-store.js';
import type {
  BackgroundAnalyzerConfig,
  BackgroundAnalyzerOptions,
  ChatAnalysisResult,
  AnalysisResult,
  DetectedPattern,
  ParsedMessageEntry,
  DEFAULT_BACKGROUND_ANALYZER_CONFIG,
} from './types.js';

const logger = createLogger('BackgroundAnalyzer');

/**
 * Message entry from the log file (raw format).
 */
interface RawMessageEntry {
  messageId: string;
  senderId: string;
  timestamp: string;
  content: string;
  messageType: string;
  direction: 'incoming' | 'outgoing';
}

/**
 * Background Analyzer - Periodically analyzes user interactions.
 *
 * Usage:
 * ```typescript
 * const analyzer = new BackgroundAnalyzer({
 *   config: { enabled: true, analysisInterval: '0 3 * * *', ... },
 *   patternStore,
 *   messageLogger,
 *   onPatternsDetected: async (result) => {
 *     // Handle detected patterns
 *   },
 * });
 *
 * await analyzer.start();
 * ```
 */
export class BackgroundAnalyzer {
  private config: BackgroundAnalyzerConfig;
  private patternStore: PatternStore;
  private messageLogger: import('../feishu/message-logger.js').MessageLogger;
  private onPatternsDetected?: (result: ChatAnalysisResult) => Promise<void>;
  private cronJob: CronJob | null = null;
  private running = false;
  private chatDir: string;

  constructor(options: BackgroundAnalyzerOptions) {
    this.config = options.config;
    this.patternStore = options.patternStore;
    this.messageLogger = options.messageLogger;
    this.onPatternsDetected = options.onPatternsDetected;

    const workspaceDir = Config.getWorkspaceDir();
    this.chatDir = path.join(workspaceDir, 'chat');
  }

  /**
   * Start the background analyzer.
   * Schedules periodic analysis based on config.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Background analyzer already running');
      return;
    }

    if (!this.config.enabled) {
      logger.info('Background analyzer is disabled');
      return;
    }

    try {
      this.cronJob = new CronJob(
        this.config.analysisInterval,
        () => this.runAnalysis(),
        null,
        true, // start
        'Asia/Shanghai' // timezone
      );

      this.running = true;
      logger.info(
        { cron: this.config.analysisInterval, lookbackDays: this.config.lookbackDays },
        'Background analyzer started'
      );
    } catch (error) {
      logger.error({ err: error }, 'Failed to start background analyzer');
      throw error;
    }
  }

  /**
   * Stop the background analyzer.
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    this.running = false;
    logger.info('Background analyzer stopped');
  }

  /**
   * Check if the analyzer is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Run analysis manually (for testing or immediate execution).
   */
  async runAnalysisNow(): Promise<AnalysisResult> {
    return this.runAnalysis();
  }

  /**
   * Run the analysis process.
   */
  private async runAnalysis(): Promise<AnalysisResult> {
    logger.info('Starting background analysis');

    const startTime = Date.now();
    const chats: ChatAnalysisResult[] = [];

    try {
      // Get all chat history files
      const chatFiles = await this.getChatFiles();
      logger.info({ chatCount: chatFiles.length }, 'Found chat files to analyze');

      // Analyze each chat
      for (const chatFile of chatFiles) {
        try {
          const result = await this.analyzeChat(chatFile);
          if (result) {
            chats.push(result);

            // Save patterns to store
            await this.patternStore.saveChatPatterns(result.chatId, result);

            // Notify callback if patterns detected
            if (result.patterns.length > 0 && this.onPatternsDetected) {
              await this.onPatternsDetected(result);
            }
          }
        } catch (error) {
          logger.error({ err: error, chatFile }, 'Failed to analyze chat');
        }
      }

      // Build and save complete analysis result
      const result: AnalysisResult = {
        chats,
        analyzedAt: new Date().toISOString(),
        config: this.config,
        summary: {
          totalChats: chats.length,
          totalPatterns: chats.reduce((sum, c) => sum + c.patterns.length, 0),
          highConfidencePatterns: chats.reduce(
            (sum, c) => sum + c.patterns.filter((p) => p.confidence >= 0.8).length,
            0
          ),
        },
      };

      await this.patternStore.saveLatestAnalysis(result);

      const duration = Date.now() - startTime;
      logger.info(
        {
          duration,
          totalChats: result.summary.totalChats,
          totalPatterns: result.summary.totalPatterns,
        },
        'Background analysis completed'
      );

      return result;
    } catch (error) {
      logger.error({ err: error }, 'Background analysis failed');
      throw error;
    }
  }

  /**
   * Get all chat history files.
   */
  private async getChatFiles(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.chatDir);
      return files
        .filter((f) => f.endsWith('.md'))
        .map((f) => path.join(this.chatDir, f));
    } catch {
      return [];
    }
  }

  /**
   * Analyze a single chat file.
   */
  private async analyzeChat(chatFilePath: string): Promise<ChatAnalysisResult | null> {
    try {
      const content = await fs.readFile(chatFilePath, 'utf-8');

      // Extract chat ID from filename
      const filename = path.basename(chatFilePath, '.md');

      // Parse messages
      const messages = this.parseMessages(content);

      if (messages.length === 0) {
        return null;
      }

      // Filter by lookback period
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.config.lookbackDays);

      const recentMessages = messages.filter((m) => m.timestamp >= cutoffDate);

      if (recentMessages.length === 0) {
        return null;
      }

      // Extract chat ID from file header or filename
      const chatId = this.extractChatId(content) || filename;

      // Detect patterns (basic implementation)
      const patterns = this.detectPatterns(chatId, recentMessages);

      // Determine time range
      const timestamps = recentMessages.map((m) => m.timestamp.getTime());
      const timeRange = {
        start: new Date(Math.min(...timestamps)).toISOString(),
        end: new Date(Math.max(...timestamps)).toISOString(),
      };

      return {
        chatId,
        patterns,
        analyzedAt: new Date().toISOString(),
        messageCount: recentMessages.length,
        timeRange,
      };
    } catch (error) {
      logger.error({ err: error, chatFilePath }, 'Failed to analyze chat file');
      return null;
    }
  }

  /**
   * Parse messages from markdown content.
   */
  private parseMessages(content: string): ParsedMessageEntry[] {
    const messages: ParsedMessageEntry[] = [];

    // Match message sections
    // Format: ## [timestamp] emoji direction (message_id: xxx)
    const messageRegex =
      /##\s*\[([^\]]+)\]\s*(📥|📤)\s*(User|Bot)\s*\(message_id:\s*([^)]+)\)/g;

    let match;
    while ((match = messageRegex.exec(content)) !== null) {
      const [, timestampStr, emoji, , messageId] = match;

      // Extract content between this message and the next ---
      const contentStart = match.index + match[0].length;
      const nextSection = content.indexOf('\n---\n', contentStart);
      const contentEnd = nextSection !== -1 ? nextSection : content.length;
      const messageContent = content
        .slice(contentStart, contentEnd)
        .replace(/\*\*Sender\*\*:\s*[^\n]+\n/, '')
        .replace(/\*\*Type\*\*:\s*[^\n]+\n/, '')
        .trim();

      messages.push({
        messageId,
        senderId: '', // Not needed for pattern detection
        timestamp: new Date(timestampStr),
        content: messageContent,
        messageType: 'text',
        direction: emoji === '📥' ? 'incoming' : 'outgoing',
      });
    }

    return messages;
  }

  /**
   * Extract chat ID from file header.
   */
  private extractChatId(content: string): string | null {
    const match = content.match(/\*\*Chat ID\*\*:\s*(.+)/);
    return match ? match[1].trim() : null;
  }

  /**
   * Detect patterns from messages.
   *
   * This is a basic implementation that identifies:
   * - Similar requests occurring multiple times
   * - Time-based patterns (daily, weekly)
   *
   * For more sophisticated analysis, the data can be passed to the
   * schedule-recommend skill which uses LLM-based analysis.
   */
  private detectPatterns(chatId: string, messages: ParsedMessageEntry[]): DetectedPattern[] {
    const patterns: DetectedPattern[] = [];

    // Only analyze incoming user messages
    const userMessages = messages.filter((m) => m.direction === 'incoming');

    if (userMessages.length < this.config.minOccurrences) {
      return patterns;
    }

    // Group similar messages
    const messageGroups = this.groupSimilarMessages(userMessages);

    // Analyze each group for patterns
    for (const group of messageGroups.values()) {
      if (group.length >= this.config.minOccurrences) {
        const pattern = this.createPatternFromGroup(chatId, group);
        if (pattern && pattern.confidence >= this.config.minConfidence) {
          patterns.push(pattern);
        }
      }
    }

    return patterns;
  }

  /**
   * Group similar messages together.
   * Uses keyword matching to identify similar requests.
   */
  private groupSimilarMessages(messages: ParsedMessageEntry[]): Map<string, ParsedMessageEntry[]> {
    const groups = new Map<string, ParsedMessageEntry[]>();

    // Keywords that indicate task types
    const taskKeywords: Record<string, string[]> = {
      'issue-check': ['issue', 'issues', 'github', '问题', '查看'],
      'report-generation': ['报告', 'report', '总结', 'summary', '汇总'],
      'status-check': ['状态', 'status', '检查', 'check', '查看'],
      'pr-review': ['pr', 'pull request', '合并', 'review'],
      'schedule-task': ['定时', 'schedule', '自动', 'automate'],
    };

    for (const message of messages) {
      const content = message.content.toLowerCase();

      // Find matching task type
      let matchedType: string | null = null;
      for (const [type, keywords] of Object.entries(taskKeywords)) {
        if (keywords.some((kw) => content.includes(kw))) {
          matchedType = type;
          break;
        }
      }

      if (matchedType) {
        const existing = groups.get(matchedType) || [];
        existing.push(message);
        groups.set(matchedType, existing);
      }
    }

    return groups;
  }

  /**
   * Create a pattern from a group of similar messages.
   */
  private createPatternFromGroup(
    chatId: string,
    messages: ParsedMessageEntry[]
  ): DetectedPattern | null {
    if (messages.length === 0) {
      return null;
    }

    // Determine task type from the first message's group
    const taskType = this.inferTaskType(messages);

    // Analyze time patterns
    const schedule = this.analyzeTimePattern(messages);

    // Calculate confidence based on:
    // - Number of occurrences (more = higher confidence)
    // - Time consistency (regular intervals = higher confidence)
    const occurrenceScore = Math.min(messages.length / 10, 1);
    const timeConsistencyScore = schedule.consistency;
    const confidence = (occurrenceScore * 0.6 + timeConsistencyScore * 0.4);

    // Generate recommended prompt based on task type
    const recommendedPrompt = this.generateRecommendedPrompt(taskType, messages);

    return {
      id: this.generatePatternId(chatId, taskType),
      taskType,
      occurrences: messages.length,
      suggestedSchedule: schedule.cron,
      scheduleDescription: schedule.description,
      confidence,
      samplePrompts: messages.slice(0, 3).map((m) => m.content.slice(0, 100)),
      chatId,
      firstDetectedAt: new Date(Math.min(...messages.map((m) => m.timestamp.getTime()))).toISOString(),
      lastUpdated: new Date().toISOString(),
      recommendedPrompt,
      status: 'pending',
    };
  }

  /**
   * Infer task type from messages.
   */
  private inferTaskType(messages: ParsedMessageEntry[]): string {
    // Combine all message content
    const combinedContent = messages.map((m) => m.content.toLowerCase()).join(' ');

    // Check for specific patterns
    if (combinedContent.includes('issue') || combinedContent.includes('问题')) {
      return 'issue-check';
    }
    if (combinedContent.includes('报告') || combinedContent.includes('report')) {
      return 'report-generation';
    }
    if (combinedContent.includes('pr') || combinedContent.includes('pull request')) {
      return 'pr-review';
    }
    if (combinedContent.includes('状态') || combinedContent.includes('status')) {
      return 'status-check';
    }

    return 'general-task';
  }

  /**
   * Analyze time pattern from messages.
   */
  private analyzeTimePattern(messages: ParsedMessageEntry[]): {
    cron: string;
    description: string;
    consistency: number;
  } {
    if (messages.length < 2) {
      return {
        cron: '0 9 * * *', // Default: daily at 9am
        description: '每天 09:00',
        consistency: 0.5,
      };
    }

    // Sort messages by timestamp
    const sorted = [...messages].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    // Extract hours and days of week
    const hours = sorted.map((m) => m.timestamp.getHours());
    const daysOfWeek = sorted.map((m) => m.timestamp.getDay());

    // Find most common hour
    const hourCounts = new Map<number, number>();
    for (const h of hours) {
      hourCounts.set(h, (hourCounts.get(h) || 0) + 1);
    }
    const mostCommonHour = [...hourCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];

    // Check if it's a weekly pattern (same day of week)
    const dayCounts = new Map<number, number>();
    for (const d of daysOfWeek) {
      dayCounts.set(d, (dayCounts.get(d) || 0) + 1);
    }
    const mostCommonDay = [...dayCounts.entries()].sort((a, b) => b[1] - a[1])[0];

    // Determine if weekly or daily
    const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    if (mostCommonDay[1] >= messages.length * 0.6) {
      // Weekly pattern
      const cron = `${mostCommonHour} * * ${mostCommonDay[0]}`;
      return {
        cron,
        description: `每${dayNames[mostCommonDay[0]]} ${mostCommonHour.toString().padStart(2, '0')}:00`,
        consistency: mostCommonDay[1] / messages.length,
      };
    } else {
      // Daily pattern
      const cron = `${mostCommonHour} * * *`;
      return {
        cron,
        description: `每天 ${mostCommonHour.toString().padStart(2, '0')}:00`,
        consistency: 0.7,
      };
    }
  }

  /**
   * Generate a recommended prompt for the detected pattern.
   */
  private generateRecommendedPrompt(taskType: string, messages: ParsedMessageEntry[]): string {
    // Get the most representative message
    const sampleContent = messages[0].content.slice(0, 200);

    switch (taskType) {
      case 'issue-check':
        return `检查 hs3180/disclaude 仓库中所有 open 状态的 issues，排除已有 open PR 关联的 issues，按优先级排序后发送摘要报告。`;

      case 'report-generation':
        return `生成工作报告，包含近期的主要进展和待处理事项。`;

      case 'pr-review':
        return `检查待审核的 PR 列表，提供简要概述。`;

      case 'status-check':
        return `检查系统状态并提供报告。`;

      default:
        return `执行任务: ${sampleContent}`;
    }
  }

  /**
   * Generate a unique pattern ID.
   */
  private generatePatternId(chatId: string, taskType: string): string {
    const timestamp = Date.now();
    const hash = this.simpleHash(`${chatId}:${taskType}:${timestamp}`);
    return `pattern-${hash}`;
  }

  /**
   * Simple hash function.
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }
}
