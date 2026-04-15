/**
 * Composable guidance builder for user taste preferences.
 *
 * Formats taste rules as a guidance section for agent prompts,
 * following the same pattern as other guidance builders in
 * the message-builder module.
 *
 * @see Issue #2335 — auto-summarize user taste to avoid repeated corrections
 * @see agents/message-builder/guidance.ts — pattern reference
 */

import type { TasteRule, TasteCategory } from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Category Display Names
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Human-readable labels for taste categories.
 */
const CATEGORY_LABELS: Record<TasteCategory, string> = {
  code_style: '代码风格',
  interaction: '交互偏好',
  technical: '技术选择',
  project_convention: '项目规范',
};

/**
 * Get the display label for a taste category.
 */
export function getCategoryLabel(category: TasteCategory): string {
  return CATEGORY_LABELS[category] ?? category;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Guidance Builder
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Build the taste guidance section for agent prompts.
 *
 * Formats taste rules as a structured section that tells the Agent
 * what user preferences to follow. Injected into the prompt so
 * the Agent automatically applies these preferences.
 *
 * Rules are grouped by category for readability.
 * Each rule includes its source and enforcement weight.
 *
 * @param rules - Array of taste rules from the TasteStore
 * @returns Formatted taste guidance section, or empty string if no rules
 *
 * @example
 * ```typescript
 * const rules = store.getRules();
 * const section = buildTasteGuidance(rules);
 * // Returns formatted section like:
 * // ## User Preferences (auto-learned)
 * // Follow these preferences in all responses:
 * // ### 代码风格
 * // - Use const/let, never var（被纠正 3 次）
 * // - Function names use camelCase（手动设置）
 * ```
 */
export function buildTasteGuidance(rules: TasteRule[]): string {
  if (!rules || rules.length === 0) {
    return '';
  }

  // Group rules by category
  const grouped = new Map<TasteCategory, TasteRule[]>();
  for (const rule of rules) {
    const group = grouped.get(rule.category) ?? [];
    group.push(rule);
    grouped.set(rule.category, group);
  }

  // Build sections per category
  const categorySections: string[] = [];

  for (const [category, categoryRules] of grouped) {
    const label = getCategoryLabel(category);
    const items = categoryRules
      .map((rule) => formatRule(rule))
      .join('\n');
    categorySections.push(`### ${label}\n${items}`);
  }

  return `

---

## User Preferences (auto-learned)

The following preferences were learned from your interactions. Follow these in all responses:

${categorySections.join('\n\n')}

**Important**: These preferences have been accumulated from past interactions. Apply them consistently without asking the user each time. If a preference seems outdated, the user can edit \`taste.yaml\` in the workspace directory.

---
`;
}

/**
 * Format a single taste rule as a bullet point.
 *
 * Includes enforcement context (correction count, source) to help
 * the Agent understand how strongly to apply the rule.
 */
function formatRule(rule: TasteRule): string {
  let suffix = '';

  if (rule.source === 'auto' && rule.correctionCount && rule.correctionCount > 0) {
    suffix = `（被纠正 ${rule.correctionCount} 次）`;
  } else if (rule.source === 'manual') {
    suffix = '（手动设置）';
  } else if (rule.source === 'claude_md') {
    suffix = '（来自 CLAUDE.md）';
  }

  return `- ${rule.content}${suffix}`;
}
