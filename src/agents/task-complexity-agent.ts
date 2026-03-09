/**
 * Task Complexity Agent - Evaluates task complexity using LLM-based analysis.
 *
 * Issue #857: Complex Task Auto-Start Task Agent
 *
 * Uses LLM prompts to evaluate task complexity instead of pre-defined rules.
 * Estimates completion time based on historical data when available.
 *
 * @module agents/task-complexity-agent
 */

import { BaseAgent } from './base-agent.js';
import type { AgentMessage } from '../types/agent.js';
import type { BaseAgentConfig } from './types.js';
import { taskHistoryStorage } from './task-history.js';
import { etaPredictor, type ETAPrediction } from './eta-predictor.js';
import { createLogger } from '../utils/logger.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const logger = createLogger('TaskComplexityAgent');

/**
 * Complexity level classification.
 */
export type ComplexityLevel = 'trivial' | 'low' | 'medium' | 'high' | 'critical';

/**
 * Task complexity analysis result.
 */
export interface TaskComplexityResult {
  /** Complexity score 1-10 */
  complexityScore: number;
  /** Complexity level classification */
  complexityLevel: ComplexityLevel;
  /** Estimated number of steps */
  estimatedSteps: number;
  /** Estimated completion time in seconds */
  estimatedSeconds: number;
  /** Confidence level 0-1 */
  confidence: number;
  /** Detailed reasoning */
  reasoning: {
    taskType: string;
    scope: string;
    uncertainty: string;
    dependencies: string[];
    keyFactors: string[];
  };
  /** Recommendation for task handling */
  recommendation: {
    shouldStartTaskAgent: boolean;
    reportingInterval: number;
    message: string;
  };
}

/**
 * Configuration for TaskComplexityAgent.
 */
export interface TaskComplexityAgentConfig extends BaseAgentConfig {
  /** Threshold for starting Task Agent (default: 7) */
  complexityThreshold?: number;
  /** Minimum confidence to trust estimate (default: 0.5) */
  minConfidence?: number;
}

/**
 * Task Complexity Agent.
 *
 * Analyzes user messages to determine task complexity using LLM prompts.
 * Uses historical data for time estimation when available.
 *
 * @example
 * ```typescript
 * const agent = new TaskComplexityAgent(config);
 *
 * const result = await agent.analyze({
 *   chatId: 'chat_123',
 *   messageId: 'msg_456',
 *   userMessage: 'Refactor the authentication module',
 * });
 *
 * if (result.recommendation.shouldStartTaskAgent) {
 *   // Start Task Agent with progress reporting
 * }
 * ```
 */
export class TaskComplexityAgent extends BaseAgent {
  readonly type = 'skill' as const;
  readonly name = 'TaskComplexityAgent';

  private readonly complexityThreshold: number;

  constructor(config: TaskComplexityAgentConfig) {
    super(config);
    this.complexityThreshold = config.complexityThreshold ?? 7;
    // minConfidence is stored for future use in confidence filtering
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    config.minConfidence ?? 0.5;
  }

  protected getAgentName(): string {
    return 'TaskComplexityAgent';
  }

  /**
   * Analyze a user message to determine task complexity.
   *
   * @param params - Analysis parameters
   * @returns Complexity analysis result
   */
  async analyze(params: {
    chatId: string;
    messageId: string;
    userMessage: string;
  }): Promise<TaskComplexityResult> {
    const { chatId, messageId, userMessage } = params;

    logger.info({ chatId, messageId, messageLength: userMessage.length }, 'Analyzing task complexity');

    try {
      // Get historical context for similar tasks
      const historicalContext = await this.getHistoricalContext(userMessage);

      // Infer task type for ETA prediction
      const taskType = this.inferTaskType(userMessage);

      // Get ETA prediction from ETAPredictor (Issue #1234)
      const etaPrediction = await etaPredictor.predictETA({
        taskType,
        description: userMessage,
      });

      // Build prompt from skill template
      const prompt = await this.buildPrompt({
        chatId,
        messageId,
        userMessage,
        historicalContext,
        etaContext: etaPredictor.formatPrediction(etaPrediction),
      });

      // Query LLM for complexity analysis
      const options = this.createSdkOptions({
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit'], // No tools needed for analysis
      });

      let rawResponse = '';
      for await (const { parsed } of this.queryOnce(prompt, options)) {
        if (parsed.content) {
          rawResponse += parsed.content;
        }
        if (parsed.type === 'result') {
          break;
        }
      }

      // Parse LLM response
      const result = this.parseResponse(rawResponse);

      // Enhance ETA with historical prediction if LLM confidence is low
      // or if ETAPredictor has high confidence historical data (Issue #1234)
      const enhancedResult = this.enhanceWithHistoricalETA(result, etaPrediction);

      logger.info({
        chatId,
        messageId,
        complexityScore: enhancedResult.complexityScore,
        complexityLevel: enhancedResult.complexityLevel,
        estimatedSeconds: enhancedResult.estimatedSeconds,
        confidence: enhancedResult.confidence,
        etaBasedOn: etaPrediction.basedOn,
      }, 'Task complexity analysis complete');

      return enhancedResult;
    } catch (error) {
      logger.error({ err: error, chatId, messageId }, 'Task complexity analysis failed');

      // Return conservative default on error
      return this.getDefaultResult();
    }
  }

  /**
   * Enhance LLM result with historical ETA prediction.
   * Issue #1234: Use historical data to improve ETA accuracy.
   */
  private enhanceWithHistoricalETA(
    llmResult: TaskComplexityResult,
    etaPrediction: ETAPrediction
  ): TaskComplexityResult {
    // Use historical ETA if:
    // 1. ETAPredictor has high confidence historical data, OR
    // 2. LLM confidence is low and ETAPredictor has some data
    const useHistoryETA =
      etaPrediction.basedOn === 'historical' ||
      (etaPrediction.basedOn === 'similar_tasks' && llmResult.confidence < 0.5);

    if (useHistoryETA) {
      // Blend LLM estimate with historical estimate
      const historicalWeight = etaPrediction.confidence;
      const blendedETA = Math.round(
        llmResult.estimatedSeconds * (1 - historicalWeight) +
        etaPrediction.estimatedSeconds * historicalWeight
      );

      return {
        ...llmResult,
        estimatedSeconds: blendedETA,
        confidence: Math.max(llmResult.confidence, etaPrediction.confidence),
        reasoning: {
          ...llmResult.reasoning,
          keyFactors: [
            ...llmResult.reasoning.keyFactors,
            `ETA基于历史数据 (${etaPrediction.basedOn})`,
          ],
        },
      };
    }

    return llmResult;
  }

  /**
   * Build prompt from skill template.
   */
  private async buildPrompt(params: {
    chatId: string;
    messageId: string;
    userMessage: string;
    historicalContext: string;
    etaContext?: string;
  }): Promise<string> {
    const { chatId, messageId, userMessage, historicalContext, etaContext } = params;

    // Create temporary file path for historical data reference
    const historicalDataPath = join(tmpdir(), `task-history-${Date.now()}.txt`);
    await fs.writeFile(historicalDataPath, historicalContext);

    // Read skill template
    const skillPath = join(process.cwd(), 'skills', 'task-complexity', 'SKILL.md');
    let template: string;

    try {
      template = await fs.readFile(skillPath, 'utf-8');
    } catch {
      // Fall back to inline prompt if skill file not found
      template = this.getInlinePrompt();
    }

    // Replace placeholders
    return template
      .replace('{chatId}', chatId)
      .replace('{messageId}', messageId)
      .replace('{userMessage}', userMessage)
      .replace('{historicalDataPath}', historicalDataPath)
      .replace('{historicalData}', historicalContext)
      .replace('{etaContext}', etaContext || '暂无历史ETA数据');
  }

  /**
   * Get historical context for time estimation.
   */
  private async getHistoricalContext(userMessage: string): Promise<string> {
    try {
      // Infer task type from message
      const taskType = this.inferTaskType(userMessage);

      // Get historical data
      return await taskHistoryStorage.getHistoricalContext(taskType);
    } catch (error) {
      logger.debug({ err: error }, 'Failed to get historical context, using default');
      return 'No historical data available.';
    }
  }

  /**
   * Infer task type from user message.
   */
  private inferTaskType(message: string): string {
    const lowerMessage = message.toLowerCase();

    // Simple keyword-based classification
    if (/refactor|重(构|写)|改造/.test(lowerMessage)) {
      return 'refactoring';
    }
    if (/add|新增|添加|implement|实现/.test(lowerMessage)) {
      return 'feature';
    }
    if (/fix|修复|bug|问题/.test(lowerMessage)) {
      return 'bugfix';
    }
    if (/test|测试/.test(lowerMessage)) {
      return 'testing';
    }
    if (/document|文档|readme/.test(lowerMessage)) {
      return 'documentation';
    }
    if (/what|how|why|什么|怎么|为什么|解释|explain/.test(lowerMessage)) {
      return 'explanation';
    }
    if (/read|读取|查看|show|显示/.test(lowerMessage)) {
      return 'read';
    }

    return 'general';
  }

  /**
   * Parse LLM response to extract complexity result.
   */
  private parseResponse(response: string): TaskComplexityResult {
    try {
      // Try to extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Validate and normalize
      return {
        complexityScore: Math.min(10, Math.max(1, parsed.complexityScore ?? 5)),
        complexityLevel: this.scoreToLevel(parsed.complexityScore ?? 5),
        estimatedSteps: Math.max(1, parsed.estimatedSteps ?? 1),
        estimatedSeconds: Math.max(10, parsed.estimatedSeconds ?? 60),
        confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0.5)),
        reasoning: parsed.reasoning ?? {
          taskType: 'general',
          scope: 'unknown',
          uncertainty: 'medium',
          dependencies: [],
          keyFactors: [],
        },
        recommendation: parsed.recommendation ?? {
          shouldStartTaskAgent: false,
          reportingInterval: 0,
          message: '',
        },
      };
    } catch (error) {
      logger.warn({ err: error, response }, 'Failed to parse complexity response, using default');

      // Try to infer from response text
      return this.inferFromText(response);
    }
  }

  /**
   * Infer complexity from response text when JSON parsing fails.
   */
  private inferFromText(response: string): TaskComplexityResult {
    const lowerResponse = response.toLowerCase();

    // Look for complexity indicators
    let score = 5; // default medium

    if (/trivial|简单|low|easy/.test(lowerResponse)) {
      score = 3;
    } else if (/complex|复杂|high|difficult/.test(lowerResponse)) {
      score = 7;
    } else if (/critical|严重|very complex|非常复杂/.test(lowerResponse)) {
      score = 9;
    }

    const level = this.scoreToLevel(score);
    const shouldStartTaskAgent = score >= this.complexityThreshold;

    return {
      complexityScore: score,
      complexityLevel: level,
      estimatedSteps: Math.ceil(score / 2),
      estimatedSeconds: score * 30,
      confidence: 0.3, // Low confidence for inferred results
      reasoning: {
        taskType: 'general',
        scope: 'unknown',
        uncertainty: 'high',
        dependencies: [],
        keyFactors: ['Inferred from text due to parsing error'],
      },
      recommendation: {
        shouldStartTaskAgent,
        reportingInterval: shouldStartTaskAgent ? 60 : 0,
        message: shouldStartTaskAgent ? '检测到可能为复杂任务' : '',
      },
    };
  }

  /**
   * Convert score to complexity level.
   */
  private scoreToLevel(score: number): ComplexityLevel {
    if (score <= 2) { return 'trivial'; }
    if (score <= 4) { return 'low'; }
    if (score <= 6) { return 'medium'; }
    if (score <= 8) { return 'high'; }
    return 'critical';
  }

  /**
   * Get default result when analysis fails.
   */
  private getDefaultResult(): TaskComplexityResult {
    return {
      complexityScore: 5,
      complexityLevel: 'medium',
      estimatedSteps: 3,
      estimatedSeconds: 120,
      confidence: 0.3,
      reasoning: {
        taskType: 'general',
        scope: 'unknown',
        uncertainty: 'high',
        dependencies: [],
        keyFactors: ['Analysis failed, using default values'],
      },
      recommendation: {
        shouldStartTaskAgent: false,
        reportingInterval: 0,
        message: '',
      },
    };
  }

  /**
   * Inline prompt fallback when skill file is not available.
   */
  private getInlinePrompt(): string {
    return `# Task Complexity Evaluator

Analyze the following user message and determine task complexity.

Context:
- Chat ID: {chatId}
- Message ID: {messageId}
- User Message: {userMessage}
- Historical Data: {historicalData}
- ETA Prediction: {etaContext}

Respond with a JSON object ONLY (no markdown, no explanation):

{
  "complexityScore": 7,
  "complexityLevel": "high",
  "estimatedSteps": 5,
  "estimatedSeconds": 300,
  "confidence": 0.75,
  "reasoning": {
    "taskType": "code_modification",
    "scope": "multiple_files",
    "uncertainty": "medium",
    "dependencies": ["file_system", "testing"],
    "keyFactors": ["Factor 1", "Factor 2"]
  },
  "recommendation": {
    "shouldStartTaskAgent": true,
    "reportingInterval": 60,
    "message": "检测到复杂任务"
  }
}

Complexity Score Guidelines:
- 1-2: trivial (simple question, no action needed)
- 3-4: low (single operation, clear outcome)
- 5-6: medium (multiple steps, moderate uncertainty)
- 7-8: high (complex multi-step, significant uncertainty)
- 9-10: critical (system-wide changes, high risk)

Consider historical data for time estimation. If historical data shows similar tasks took longer, adjust accordingly.`;
  }

  /**
   * Execute the skill (implements SkillAgent interface).
   */
  async *execute(input: string): AsyncGenerator<AgentMessage> {
    const params = JSON.parse(input);
    const result = await this.analyze(params);

    yield {
      content: JSON.stringify(result),
      role: 'assistant',
      messageType: 'text',
    };
  }
}

/**
 * Create a TaskComplexityAgent instance.
 */
export function createTaskComplexityAgent(config: TaskComplexityAgentConfig): TaskComplexityAgent {
  return new TaskComplexityAgent(config);
}
