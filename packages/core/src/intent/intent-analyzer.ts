/**
 * Intent Convergence Protocol — Intent Analyzer
 *
 * Analyzes user messages to detect data processing tasks
 * and determine whether the intent convergence flow should be triggered.
 *
 * Phase 1 component of #4152.
 * @module intent/intent-analyzer
 */

import type { IntentAnalysis } from './types.js';

/**
 * Keywords that signal data processing tasks.
 *
 * For English keywords, use a simple alternation that matches at word start
 * (preceded by whitespace/punctuation/start-of-string). For CJK keywords,
 * no boundary is needed since CJK characters are self-delimiting.
 */
const DATA_PROCESSING_PATTERNS: RegExp[] = [
  /(?:^|[\s,.!?])parse|解析/i,
  /(?:^|[\s,.!?])convert|转换|转[换为成]/i,
  /(?:^|[\s,.!?])extract|提取|抽取/i,
  /(?:^|[\s,.!?])summarize|汇总|统计/i,
  /(?:^|[\s,.!?])merge|合并|整合/i,
  /(?:^|[\s,.!?])filter|筛选|过滤/i,
  /(?:^|[\s,.!?])sort|排序/i,
  /(?:^|[\s,.!?])calculate|计算|算[一下出]?/i,
  /(?:^|[\s,.!?])analyze|分析/i,
  /(?:^|[\s,.!?])export|导出/i,
  /(?:^|[\s,.!?])import|导入/i,
  /(?:^|[\s,.!?])report|报表|报告/i,
  /(?:^|[\s,.!?])validate|校验|检查/i,
  /(?:^|[\s,.!?])clean|清洗|清理/i,
  /(?:^|[\s,.!?])format|格式化/i,
  /(?:^|[\s,.!?])process|处理/i,
  /(?:^|[\s,.!?])crawl|爬取|抓取/i,
  /(?:^|[\s,.!?])transform|变换/i,
  /(?:^|[\s,.!?])normalize|标准化/i,
  /(?:^|[\s,.!?])compare|比较|对比/i,
];

/** Patterns for detecting data format hints in user messages. */
const FORMAT_HINT_PATTERNS: Array<{ pattern: RegExp; format: string }> = [
  { pattern: /csv/i, format: 'CSV' },
  { pattern: /excel|xlsx|xls/i, format: 'Excel' },
  { pattern: /json/i, format: 'JSON' },
  { pattern: /yaml|yml/i, format: 'YAML' },
  { pattern: /xml/i, format: 'XML' },
  { pattern: /markdown/i, format: 'Markdown' },
  { pattern: /数据库|database|sql|db/i, format: 'Database' },
  { pattern: /pdf/i, format: 'PDF' },
  { pattern: /图片|image|png|jpg/i, format: 'Image' },
  { pattern: /表格|spreadsheet|sheet/i, format: 'Spreadsheet' },
  { pattern: /api|接口/i, format: 'API' },
];

/**
 * Analyze a user message to detect data processing intent.
 *
 * Returns an IntentAnalysis indicating whether the convergence
 * flow should be triggered and what data hints were detected.
 *
 * @param userMessage - The raw text of the user's message
 */
export function analyzeIntent(userMessage: string): IntentAnalysis {
  const dataHints: string[] = [];

  // Detect format hints
  for (const { pattern, format } of FORMAT_HINT_PATTERNS) {
    if (pattern.test(userMessage)) {
      dataHints.push(format);
    }
  }

  // Detect data processing patterns
  const matchedPatterns: string[] = [];
  for (const pattern of DATA_PROCESSING_PATTERNS) {
    if (pattern.test(userMessage)) {
      const match = userMessage.match(pattern);
      if (match) {matchedPatterns.push(match[0]);}
    }
  }

  const isDataProcessingTask = matchedPatterns.length > 0;
  const needsConvergence = isDataProcessingTask;

  return {
    isDataProcessingTask,
    dataHints,
    needsConvergence,
    reason: needsConvergence
      ? `Detected data processing patterns: ${matchedPatterns.join(', ')}`
      : 'No data processing patterns detected in user message.',
  };
}
