/**
 * Prompt Parts - 导出所有 prompt 组件
 */

import { COLD_READING_PROMPT, CONCERN_INFERENCE_TABLE, getConcerns } from './cold-reading.js';
import { OUTPUT_RULES_PROMPT, validateOutput } from './output-rules.js';
import { PERSONA_PROMPT, PERSONA_CONFIG } from './persona.js';

export { COLD_READING_PROMPT, CONCERN_INFERENCE_TABLE, getConcerns };
export { OUTPUT_RULES_PROMPT, validateOutput };
export type { OutputValidationResult } from './output-rules.js';
export { PERSONA_PROMPT, PERSONA_CONFIG };

/**
 * 获取完整的系统 prompt
 */
export function getFullSystemPrompt(): string {
  return `
${PERSONA_PROMPT}

---

${COLD_READING_PROMPT}

---

${OUTPUT_RULES_PROMPT}
`.trim();
}
