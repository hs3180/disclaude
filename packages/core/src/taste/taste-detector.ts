/**
 * Taste detection — extract user preference patterns from chat logs.
 *
 * Analyzes conversation logs to detect repeated user corrections,
 * which indicate preferences the Agent should learn.
 *
 * Detection signals:
 * - User correcting the same type of issue 2+ times
 * - User modifying Agent-generated content with consistent patterns
 * - Explicit preference statements ("always use X", "never do Y")
 *
 * @see https://github.com/hs3180/disclaude/issues/2335
 */

import type { TasteCategory, TasteRule, DetectedCorrection, TasteData } from './types.js';

/**
 * Normalize a correction into a unique key for deduplication.
 *
 * @param rule - The preference rule text
 * @returns A normalized key
 */
function ruleToKey(rule: string): string {
  return rule
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80);
}

/**
 * Categorize a correction based on keyword heuristics.
 *
 * These are simple pattern matches — the LLM (daily-chat-review)
 * can provide more accurate categorization, but this serves as
 * a fast local fallback.
 *
 * @param text - The correction text
 * @returns Best-guess category
 */
export function categorizeCorrection(text: string): TasteCategory {
  const lower = text.toLowerCase();

  // Code style patterns
  if (/var\b|const\b|let\b|camelcase|snake_case|函数名|变量名|命名|缩进|格式化/.test(lower)) {
    return 'code_style';
  }

  // Tech preference patterns
  if (/typescript|javascript|pnpm|npm|yarn|react|vue|python|语言|框架|工具|优先|使用.*替代/.test(lower)) {
    return 'tech_preference';
  }

  // Interaction patterns
  if (/简洁|详细|回复|格式|输出|先.*后|不要.*直接|commit.*message|用中文|用英文/.test(lower)) {
    return 'interaction';
  }

  // Default to project norm
  return 'project_norm';
}

/**
 * Merge detected corrections into existing taste data.
 *
 * - New corrections are added as new rules
 * - Existing rules have their correction count incremented
 * - The lastSeen timestamp is updated
 *
 * @param existingData - Current taste data (or empty if none)
 * @param corrections - Newly detected corrections
 * @returns Updated taste data
 */
export function mergeTasteRules(
  existingData: TasteData,
  corrections: DetectedCorrection[],
): TasteData {
  const data: TasteData = {
    version: 1,
    rules: { ...existingData.rules },
    updatedAt: new Date().toISOString(),
  };

  for (const correction of corrections) {
    const key = ruleToKey(correction.rule);

    if (data.rules[key]) {
      // Existing rule: update counts and lastSeen
      const existing = data.rules[key];
      data.rules[key] = {
        ...existing,
        source: {
          ...existing.source,
          correctionCount: (existing.source.correctionCount ?? 0) + correction.count,
          lastSeen: new Date().toISOString(),
        },
      };
    } else {
      // New rule
      data.rules[key] = {
        rule: correction.rule,
        category: correction.category,
        source: {
          origin: 'auto',
          correctionCount: correction.count,
          lastSeen: new Date().toISOString(),
          example: correction.example,
        },
      };
    }
  }

  return data;
}

/**
 * Convert chat log content into detected corrections.
 *
 * This is a heuristic-based scanner that looks for common correction
 * patterns in conversation text. It's designed to be called from
 * the daily-chat-review skill or the taste management system.
 *
 * @param logContent - The text content of a chat log
 * @returns Array of detected corrections
 */
export function scanLogForCorrections(logContent: string): DetectedCorrection[] {
  const corrections: DetectedCorrection[] = [];
  const lines = logContent.split('\n');

  // Track potential corrections: pattern → { count, examples }
  const correctionMap = new Map<string, { count: number; examples: string[] }>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }

    // Only analyze user messages (lines starting with User marker or after user headers)
    const isUserMessage = line.includes('📥 User') ||
      line.startsWith('>') ||
      (i > 0 && lines[i - 1].includes('📥 User'));

    if (!isUserMessage) {
      continue;
    }

    // Detect correction patterns
    const patterns = extractCorrectionPatterns(line);
    for (const pattern of patterns) {
      const existing = correctionMap.get(pattern) ?? { count: 0, examples: [] };
      existing.count++;
      if (existing.examples.length < 3) {
        existing.examples.push(line.slice(0, 200));
      }
      correctionMap.set(pattern, existing);
    }
  }

  // Convert to DetectedCorrection (only keep patterns with 2+ occurrences)
  for (const [rule, meta] of correctionMap) {
    if (meta.count >= 2) {
      corrections.push({
        rule,
        category: categorizeCorrection(rule),
        example: meta.examples[0] ?? '',
        count: meta.count,
      });
    }
  }

  return corrections;
}

/**
 * Extract correction patterns from a single user message line.
 *
 * Looks for common correction patterns like:
 * - "不要..." (don't...)
 * - "应该是..." (should be...)
 * - "改成..." (change to...)
 * - "用...不要用..." (use X not Y)
 *
 * @param line - A single user message line
 * @returns Array of detected correction rule strings
 */
function extractCorrectionPatterns(line: string): string[] {
  const patterns: string[] = [];

  // Pattern: "不要用 X，用/要/改用 Y" → "use Y instead of X"
  const replaceMatch = line.match(/不要用?([\w\u4e00-\u9fff]+)\s*[，,]?\s*(?:改?用|要|换成)([\w\u4e00-\u9fff]+)/);
  if (replaceMatch) {
    patterns.push(`使用 ${replaceMatch[2]} 替代 ${replaceMatch[1]}`);
  }

  // Pattern: "不要..." → "avoid ..."
  const avoidMatch = line.match(/不要([\u4e00-\u9fff\w]+[^。，,.]*)/);
  if (avoidMatch && !replaceMatch) {
    patterns.push(`避免${avoidMatch[1]}`);
  }

  // Pattern: "应该是..." / "应该用..." → "should use ..."
  const shouldMatch = line.match(/应该(?:是|用)([^。，,.]+)/);
  if (shouldMatch) {
    patterns.push(`使用${shouldMatch[1]}`);
  }

  // Pattern: "改成..." / "改为..." → "change to ..."
  const changeMatch = line.match(/改成?([^\n。，,.]+)/);
  if (changeMatch) {
    patterns.push(`改为${changeMatch[1].slice(0, 50)}`);
  }

  return patterns;
}

/**
 * Build a taste guidance string for injection into agent prompts.
 *
 * Formats the taste rules into a human-readable section that
 * tells the agent what preferences to follow.
 *
 * @param data - Taste data to format
 * @returns Formatted taste guidance string, or empty string if no rules
 */
export function buildTastePromptSection(data: TasteData): string {
  const rules = Object.values(data.rules);

  if (rules.length === 0) {
    return '';
  }

  // Group by category
  const grouped = new Map<TasteCategory, TasteRule[]>();
  for (const rule of rules) {
    const existing = grouped.get(rule.category) ?? [];
    existing.push(rule);
    grouped.set(rule.category, existing);
  }

  const categoryLabels: Record<TasteCategory, string> = {
    code_style: '代码风格',
    interaction: '交互偏好',
    tech_preference: '技术选择',
    project_norm: '项目规范',
  };

  const sections: string[] = [];

  for (const [category, categoryRules] of grouped) {
    const label = categoryLabels[category];
    const items = categoryRules
      .sort((a, b) => (b.source.correctionCount ?? 0) - (a.source.correctionCount ?? 0))
      .map((rule) => {
        const count = rule.source.correctionCount;
        const suffix = count && count > 1 ? `（被纠正 ${count} 次）` : '';
        const origin = rule.source.origin === 'claude_md' ? '（来自 CLAUDE.md）' : '';
        return `- ${rule.rule}${suffix}${origin}`;
      })
      .join('\n');

    sections.push(`**${label}**:\n${items}`);
  }

  return [
    '## User Taste (auto-learned preferences)',
    '',
    'The following preferences have been detected from your interactions.',
    'Follow them strictly — they represent things you have been corrected on multiple times.',
    '',
    sections.join('\n\n'),
  ].join('\n');
}
