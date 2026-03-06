/**
 * Task Complexity Assessor - Heuristic-based task complexity assessment.
 *
 * Issue #857: Phase 1 - Task Complexity Assessment
 *
 * This module provides heuristic-based assessment of task complexity
 * based on user message content and context.
 *
 * Assessment factors:
 * - Message length
 * - Keywords indicating complex operations
 * - Code-related indicators
 * - Multi-step operation indicators
 * - External API/tool usage indicators
 *
 * @module utils/task-complexity-assessor
 */

import {
  type TaskComplexity,
  type ComplexityInput,
  type ComplexityFactor,
  type ComplexityThresholds,
  DEFAULT_COMPLEXITY_THRESHOLDS,
} from './task-complexity-types.js';

// Re-export ComplexityInput for external use
export type { ComplexityInput } from './task-complexity-types.js';
import { createLogger } from './logger.js';

const logger = createLogger('TaskComplexityAssessor');

/**
 * Keywords that indicate complex operations.
 */
const COMPLEX_KEYWORDS = [
  // Refactoring and architecture
  '重构', 'refactor', '架构', 'architecture', '设计', 'design',
  '迁移', 'migrate', '升级', 'upgrade',

  // Multi-file operations
  '所有文件', 'all files', '多个文件', 'multiple files',
  '整个项目', 'entire project', '批量', 'batch',

  // Analysis and research
  '分析', 'analyze', '调研', 'research', '审查', 'review',
  '评估', 'evaluate', '比较', 'compare',

  // Development tasks
  '实现', 'implement', '开发', 'develop', '创建', 'create',
  '构建', 'build', '部署', 'deploy',

  // Testing
  '测试', 'test', '调试', 'debug', '修复', 'fix',

  // Documentation
  '文档', 'document', '报告', 'report',
];

/**
 * Keywords that indicate simple operations.
 */
const SIMPLE_KEYWORDS = [
  '你好', 'hello', 'hi', '谢谢', 'thanks',
  '什么是', 'what is', '解释', 'explain',
  '显示', 'show', '列出', 'list',
  '帮助', 'help', '怎么', 'how to',
];

/**
 * Patterns indicating code operations.
 */
const CODE_PATTERNS = [
  /```[\s\S]*?```/g,  // Code blocks
  /`[^`]+`/g,         // Inline code
  /\bfunction\b/i,
  /\bclass\b/i,
  /\bimport\b/i,
  /\bexport\b/i,
  /\bconst\b/i,
  /\basync\b/i,
  /\bawait\b/i,
];

/**
 * Patterns indicating file operations.
 */
const FILE_PATTERNS = [
  /\.ts\b/g,
  /\.js\b/g,
  /\.py\b/g,
  /\.json\b/g,
  /\.yaml\b/g,
  /\.md\b/g,
  /src\//g,
  /lib\//g,
  /文件/g,
  /file/gi,
];

/**
 * Configuration for the complexity assessor.
 */
export interface ComplexityAssessorConfig {
  /** Complexity thresholds */
  thresholds?: ComplexityThresholds;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Task Complexity Assessor.
 *
 * Provides heuristic-based assessment of task complexity.
 */
export class TaskComplexityAssessor {
  private thresholds: ComplexityThresholds;
  private verbose: boolean;

  constructor(config: ComplexityAssessorConfig = {}) {
    this.thresholds = config.thresholds ?? DEFAULT_COMPLEXITY_THRESHOLDS;
    this.verbose = config.verbose ?? false;
  }

  /**
   * Assess the complexity of a task based on input.
   *
   * @param input - The complexity input to assess
   * @returns Task complexity assessment result
   */
  assess(input: ComplexityInput): TaskComplexity {
    const factors: ComplexityFactor[] = [];
    let score = 1; // Start with minimum complexity

    // Factor 1: Message length
    const lengthFactor = this.assessLength(input.text);
    factors.push(lengthFactor);
    score += lengthFactor.weight;

    // Factor 2: Complex keywords
    const keywordFactor = this.assessKeywords(input.text);
    factors.push(keywordFactor);
    score += keywordFactor.weight;

    // Factor 3: Code patterns
    const codeFactor = this.assessCodePatterns(input.text);
    factors.push(codeFactor);
    score += codeFactor.weight;

    // Factor 4: File references
    const fileFactor = this.assessFilePatterns(input.text);
    factors.push(fileFactor);
    score += fileFactor.weight;

    // Factor 5: Attachments
    if (input.attachmentCount && input.attachmentCount > 0) {
      const attachmentWeight = Math.min(input.attachmentCount, 3);
      factors.push({
        name: 'attachments',
        weight: attachmentWeight,
        description: `Has ${input.attachmentCount} attachment(s)`,
      });
      score += attachmentWeight;
    }

    // Factor 6: Chat history context
    if (input.chatHistoryLength && input.chatHistoryLength > 1000) {
      const historyWeight = Math.min(Math.floor(input.chatHistoryLength / 2000), 2);
      factors.push({
        name: 'chatHistory',
        weight: historyWeight,
        description: `Long chat history context (${input.chatHistoryLength} chars)`,
      });
      score += historyWeight;
    }

    // Clamp score to valid range
    score = Math.max(this.thresholds.minScore, Math.min(this.thresholds.maxScore, score));

    // Calculate estimates
    const estimatedSteps = this.estimateSteps(score, factors);
    const estimatedTimeSeconds = this.estimateTime(score, estimatedSteps);

    const result: TaskComplexity = {
      score,
      estimatedSteps,
      estimatedTimeSeconds,
      reasoning: this.generateReasoning(score, factors),
      factors,
    };

    if (this.verbose) {
      logger.debug({ result }, 'Task complexity assessed');
    }

    return result;
  }

  /**
   * Assess complexity based on message length.
   */
  private assessLength(text: string): ComplexityFactor {
    const length = text.length;

    if (length < 50) {
      return {
        name: 'length',
        weight: 0,
        description: 'Short message (< 50 chars)',
      };
    }
    if (length < 200) {
      return {
        name: 'length',
        weight: 1,
        description: 'Medium message (50-200 chars)',
      };
    }
    if (length < 500) {
      return {
        name: 'length',
        weight: 2,
        description: 'Long message (200-500 chars)',
      };
    }
    return {
      name: 'length',
      weight: 3,
      description: `Very long message (${length} chars)`,
    };
  }

  /**
   * Assess complexity based on keywords.
   */
  private assessKeywords(text: string): ComplexityFactor {
    const lowerText = text.toLowerCase();
    let complexCount = 0;
    let simpleCount = 0;

    // Count complex keywords
    for (const keyword of COMPLEX_KEYWORDS) {
      if (lowerText.includes(keyword.toLowerCase())) {
        complexCount++;
      }
    }

    // Count simple keywords
    for (const keyword of SIMPLE_KEYWORDS) {
      if (lowerText.includes(keyword.toLowerCase())) {
        simpleCount++;
      }
    }

    // Net complexity from keywords
    const netComplexity = complexCount - Math.floor(simpleCount / 2);
    const weight = Math.max(0, Math.min(netComplexity, 3));

    return {
      name: 'keywords',
      weight,
      description: `${complexCount} complex keyword(s), ${simpleCount} simple keyword(s)`,
    };
  }

  /**
   * Assess complexity based on code patterns.
   */
  private assessCodePatterns(text: string): ComplexityFactor {
    let codeIndicators = 0;

    for (const pattern of CODE_PATTERNS) {
      const matches = text.match(pattern);
      if (matches) {
        codeIndicators += matches.length;
      }
    }

    const weight = Math.min(codeIndicators, 3);

    return {
      name: 'codePatterns',
      weight,
      description: `${codeIndicators} code indicator(s) found`,
    };
  }

  /**
   * Assess complexity based on file patterns.
   */
  private assessFilePatterns(text: string): ComplexityFactor {
    let fileIndicators = 0;

    for (const pattern of FILE_PATTERNS) {
      const matches = text.match(pattern);
      if (matches) {
        fileIndicators += matches.length;
      }
    }

    const weight = Math.min(Math.floor(fileIndicators / 2), 2);

    return {
      name: 'filePatterns',
      weight,
      description: `${fileIndicators} file reference(s) found`,
    };
  }

  /**
   * Estimate number of steps based on complexity.
   */
  private estimateSteps(score: number, factors: ComplexityFactor[]): number {
    // Base steps from score
    let steps = Math.ceil(score / 2);

    // Adjust based on factors
    const hasCode = factors.some(f => f.name === 'codePatterns' && f.weight > 0);
    const hasFiles = factors.some(f => f.name === 'filePatterns' && f.weight > 0);

    if (hasCode) steps += 2;
    if (hasFiles) steps += 1;

    return Math.max(1, steps);
  }

  /**
   * Estimate time in seconds based on complexity and steps.
   */
  private estimateTime(score: number, steps: number): number {
    // Base time: 10 seconds per complexity point
    const baseTime = score * 10;

    // Add time per step: 15-30 seconds depending on complexity
    const timePerStep = score > 6 ? 30 : score > 3 ? 20 : 15;
    const stepTime = steps * timePerStep;

    return baseTime + stepTime;
  }

  /**
   * Generate human-readable reasoning.
   */
  private generateReasoning(score: number, factors: ComplexityFactor[]): string {
    const significantFactors = factors.filter(f => f.weight > 0);

    if (significantFactors.length === 0) {
      return 'Simple query with no complex indicators';
    }

    const factorDescriptions = significantFactors
      .map(f => f.description)
      .join('; ');

    return `Score ${score}/10 based on: ${factorDescriptions}`;
  }
}

/**
 * Default assessor instance.
 */
export const defaultComplexityAssessor = new TaskComplexityAssessor();
