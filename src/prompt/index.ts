/**
 * Prompt 模块入口
 *
 * 提供统一的 prompt 导出，用于构建命理师对话系统。
 *
 * @example
 * ```typescript
 * import { buildSystemPrompt, getPersonaPrompt } from './prompt/index.js';
 *
 * // 获取完整系统 prompt
 * const systemPrompt = buildSystemPrompt();
 *
 * // 或单独获取某个部分
 * const persona = getPersonaPrompt();
 * ```
 *
 * @module prompt
 */

// 导出各模块
export {
  PERSONA_PROMPT,
  getPersonaPrompt,
} from './parts/persona.js';

export {
  CONCERN_INFERENCE_TABLE,
  ERROR_RECOVERY_GUIDE,
  COLD_READING_TECHNIQUES,
  getColdReadingPrompt,
  getConcernInferenceTable,
  getErrorRecoveryGuide,
} from './parts/cold-reading.js';

export {
  QUESTION_RULES,
  ASSERTION_DENSITY_RULES,
  OUTPUT_FORMAT_RULES,
  getOutputRulesPrompt,
  getQuestionRules,
  getAssertionDensityRules,
} from './parts/output-rules.js';

// 导出子模块
export * from './parts/persona.js';
export * from './parts/cold-reading.js';
export * from './parts/output-rules.js';

/**
 * 构建完整的系统 prompt
 *
 * 将所有 prompt 部分组合成完整的系统 prompt。
 *
 * @returns 完整的系统 prompt 字符串
 */
export function buildSystemPrompt(): string {
  const { getPersonaPrompt } = require('./parts/persona.js');
  const { getColdReadingPrompt } = require('./parts/cold-reading.js');
  const { getOutputRulesPrompt } = require('./parts/output-rules.js');

  return `# 命理师对话系统

${getPersonaPrompt()}

---

${getColdReadingPrompt()}

---

${getOutputRulesPrompt()}
`;
}

/**
 * Prompt 配置选项
 */
export interface PromptOptions {
  /** 是否包含人设定义 */
  includePersona?: boolean;
  /** 是否包含冷读技巧 */
  includeColdReading?: boolean;
  /** 是否包含输出规则 */
  includeOutputRules?: boolean;
}

/**
 * 构建自定义系统 prompt
 *
 * 根据选项选择性包含各部分 prompt。
 *
 * @param options - 配置选项
 * @returns 自定义的系统 prompt 字符串
 */
export function buildCustomSystemPrompt(options: PromptOptions = {}): string {
  const {
    includePersona = true,
    includeColdReading = true,
    includeOutputRules = true,
  } = options;

  const parts: string[] = ['# 命理师对话系统'];

  if (includePersona) {
    const { getPersonaPrompt } = require('./parts/persona.js');
    parts.push(getPersonaPrompt());
  }

  if (includeColdReading) {
    const { getColdReadingPrompt } = require('./parts/cold-reading.js');
    parts.push(getColdReadingPrompt());
  }

  if (includeOutputRules) {
    const { getOutputRulesPrompt } = require('./parts/output-rules.js');
    parts.push(getOutputRulesPrompt());
  }

  return parts.join('\n\n---\n\n');
}
