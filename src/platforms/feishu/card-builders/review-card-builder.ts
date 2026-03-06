/**
 * Review Card Builder.
 *
 * Provides builders for creating review cards with the "御书房批奏折" experience.
 * When AI completes tasks and requests user review, these cards provide a
 * streamlined, intuitive experience for quick decision making.
 *
 * @module platforms/feishu/card-builders/review-card-builder
 */

import {
  buildButton,
  buildDiv,
  buildDivider,
  buildActionGroup,
  buildNote,
  buildCard,
  type ButtonStyle,
  type CardElement,
  type BuiltCard,
} from './interactive-card-builder.js';

/**
 * Review theme configuration.
 */
export interface ReviewTheme {
  /** Header title */
  title: string;
  /** Header template color */
  template: BuiltCard['header'] extends { template?: infer T } ? T : never;
  /** Approve button text */
  approveText: string;
  /** Reject button text */
  rejectText: string;
  /** Request changes button text */
  requestChangesText: string;
  /** View details button text */
  viewDetailsText: string;
  /** Review icon */
  icon: string;
}

/**
 * Predefined review themes.
 */
export const REVIEW_THEMES: Record<string, ReviewTheme> = {
  /**
   * Imperial theme - "御书房批奏折" experience.
   * Provides a traditional Chinese imperial court review experience.
   */
  imperial: {
    title: '🏛️ 御书房',
    template: 'red',
    approveText: '👑 准奏',
    rejectText: '❌ 驳回',
    requestChangesText: '📝 再议',
    viewDetailsText: '🔍 详阅',
    icon: '📜',
  },
  /**
   * Modern theme - Clean professional review experience.
   */
  modern: {
    title: '📋 审批中心',
    template: 'blue',
    approveText: '✅ 批准',
    rejectText: '❌ 拒绝',
    requestChangesText: '🔄 需要修改',
    viewDetailsText: '👁️ 查看详情',
    icon: '📄',
  },
  /**
   * Minimal theme - Simple and clean.
   */
  minimal: {
    title: '审核请求',
    template: 'grey',
    approveText: '同意',
    rejectText: '拒绝',
    requestChangesText: '修改',
    viewDetailsText: '详情',
    icon: '📋',
  },
};

/**
 * Change item for review summary.
 */
export interface ChangeItem {
  /** File path or item name */
  path: string;
  /** Change type */
  type: 'added' | 'modified' | 'deleted' | 'renamed';
  /** Optional description of the change */
  description?: string;
  /** Number of lines added (for code changes) */
  additions?: number;
  /** Number of lines removed (for code changes) */
  deletions?: number;
}

/**
 * Review card configuration.
 */
export interface ReviewCardConfig {
  /** Review title/subject */
  title: string;
  /** Review summary/description */
  summary: string;
  /** Theme to use (default: 'modern') */
  theme?: 'imperial' | 'modern' | 'minimal' | ReviewTheme;
  /** List of changes to display */
  changes?: ChangeItem[];
  /** Additional context or details */
  details?: string;
  /** Action value for approve button */
  approveAction?: string;
  /** Action value for reject button */
  rejectAction?: string;
  /** Action value for request changes button */
  requestChangesAction?: string;
  /** Action value for view details button */
  viewDetailsAction?: string;
  /** Whether to show the view details button */
  showViewDetails?: boolean;
  /** Footer note */
  footerNote?: string;
  /** Optional subtitle */
  subtitle?: string;
}

/**
 * Get theme configuration.
 */
function getTheme(theme: ReviewCardConfig['theme']): ReviewTheme {
  if (typeof theme === 'object') {
    return theme;
  }
  return REVIEW_THEMES[theme || 'modern'];
}

/**
 * Get change type icon.
 */
function getChangeTypeIcon(type: ChangeItem['type']): string {
  switch (type) {
    case 'added':
      return '➕';
    case 'modified':
      return '✏️';
    case 'deleted':
      return '🗑️';
    case 'renamed':
      return '📋';
    default:
      return '📄';
  }
}

/**
 * Build a change summary element.
 */
function buildChangeSummary(changes: ChangeItem[]): CardElement[] {
  const elements: CardElement[] = [];

  // Add header
  elements.push(buildDiv(`**变更摘要** (${changes.length} 项)`));
  elements.push(buildDivider());

  // Add each change
  for (const change of changes) {
    const icon = getChangeTypeIcon(change.type);
    let changeText = `${icon} \`${change.path}\``;

    if (change.description) {
      changeText += ` - ${change.description}`;
    }

    if (change.additions !== undefined || change.deletions !== undefined) {
      const stats: string[] = [];
      if (change.additions !== undefined && change.additions > 0) {
        stats.push(`+${change.additions}`);
      }
      if (change.deletions !== undefined && change.deletions > 0) {
        stats.push(`-${change.deletions}`);
      }
      if (stats.length > 0) {
        changeText += ` (${stats.join(' / ')})`;
      }
    }

    elements.push(buildDiv(changeText));
  }

  return elements;
}

/**
 * Build action buttons for review card.
 */
function buildReviewActions(
  theme: ReviewTheme,
  approveAction: string,
  rejectAction: string,
  requestChangesAction: string,
  viewDetailsAction?: string
): CardElement[] {
  const elements: CardElement[] = [];

  // Primary actions row
  const primaryButtons = [
    buildButton({
      text: theme.approveText,
      value: approveAction,
      style: 'primary' as ButtonStyle,
    }),
    buildButton({
      text: theme.rejectText,
      value: rejectAction,
      style: 'danger' as ButtonStyle,
    }),
    buildButton({
      text: theme.requestChangesText,
      value: requestChangesAction,
      style: 'default' as ButtonStyle,
    }),
  ];

  elements.push(buildActionGroup(primaryButtons));

  // Optional view details row
  if (viewDetailsAction) {
    elements.push(
      buildActionGroup([
        buildButton({
          text: theme.viewDetailsText,
          value: viewDetailsAction,
          style: 'default' as ButtonStyle,
        }),
      ])
    );
  }

  return elements;
}

/**
 * Build a review card with "御书房批奏折" experience.
 *
 * @param config - Review card configuration
 * @returns Card object for Feishu API
 *
 * @example
 * ```typescript
 * const card = buildReviewCard({
 *   title: '代码变更请求',
 *   summary: '修复了用户认证的 bug',
 *   theme: 'imperial',
 *   changes: [
 *     { path: 'src/auth.ts', type: 'modified', additions: 10, deletions: 5 },
 *     { path: 'tests/auth.test.ts', type: 'added', additions: 30 },
 *   ],
 *   approveAction: 'approve',
 *   rejectAction: 'reject',
 *   requestChangesAction: 'request_changes',
 * });
 * ```
 */
export function buildReviewCard(config: ReviewCardConfig): BuiltCard {
  const theme = getTheme(config.theme);
  const elements: CardElement[] = [];

  // Summary section
  elements.push(buildDiv(`**${theme.icon} ${config.title}**`));
  elements.push(buildDiv(config.summary));

  // Changes section (if provided)
  if (config.changes && config.changes.length > 0) {
    elements.push(buildDivider());
    elements.push(...buildChangeSummary(config.changes));
  }

  // Details section (if provided)
  if (config.details) {
    elements.push(buildDivider());
    elements.push(buildDiv(config.details));
  }

  // Actions section
  elements.push(buildDivider());
  elements.push(
    ...buildReviewActions(
      theme,
      config.approveAction || 'approve',
      config.rejectAction || 'reject',
      config.requestChangesAction || 'request_changes',
      config.showViewDetails !== false ? config.viewDetailsAction : undefined
    )
  );

  // Footer note
  if (config.footerNote) {
    elements.push(buildNote(config.footerNote));
  }

  return buildCard({
    header: {
      title: theme.title,
      template: theme.template,
      subtitle: config.subtitle,
    },
    elements,
  });
}

/**
 * Build a simple review card for quick approvals.
 *
 * @param title - Review title
 * @param message - Review message
 * @param approveAction - Action value for approve
 * @param rejectAction - Action value for reject
 * @param theme - Theme to use (default: 'modern')
 * @returns Card object
 */
export function buildQuickReviewCard(
  title: string,
  message: string,
  approveAction = 'approve',
  rejectAction = 'reject',
  theme: ReviewCardConfig['theme'] = 'modern'
): BuiltCard {
  const themeConfig = getTheme(theme);

  return buildCard({
    header: {
      title: themeConfig.title,
      template: themeConfig.template,
    },
    elements: [
      buildDiv(`**${title}**`),
      buildDiv(message),
      buildDivider(),
      buildActionGroup([
        buildButton({
          text: themeConfig.approveText,
          value: approveAction,
          style: 'primary',
        }),
        buildButton({
          text: themeConfig.rejectText,
          value: rejectAction,
          style: 'danger',
        }),
      ]),
    ],
  });
}

/**
 * Build a review card with diff preview.
 *
 * @param config - Review card configuration
 * @param diffContent - Diff content to display
 * @param maxLines - Maximum lines to show (default: 20)
 * @returns Card object
 */
export function buildReviewCardWithDiff(
  config: ReviewCardConfig,
  diffContent: string,
  maxLines = 20
): BuiltCard {
  const theme = getTheme(config.theme);
  const elements: CardElement[] = [];

  // Summary section
  elements.push(buildDiv(`**${theme.icon} ${config.title}**`));
  elements.push(buildDiv(config.summary));

  // Diff section
  elements.push(buildDivider());
  elements.push(buildDiv('**变更内容**'));

  // Truncate diff if too long
  const lines = diffContent.split('\n');
  let displayDiff = diffContent;
  let truncated = false;

  if (lines.length > maxLines) {
    const head = lines.slice(0, Math.floor(maxLines / 2));
    const tail = lines.slice(-Math.floor(maxLines / 2));
    displayDiff = [...head, '...', `... (${lines.length - maxLines} more lines) ...`, ...tail].join('\n');
    truncated = true;
  }

  // Format diff as code block
  elements.push(buildDiv(`\`\`\`diff\n${displayDiff}\n\`\`\``));

  if (truncated) {
    elements.push(buildNote(`显示前 ${Math.floor(maxLines / 2)} 行和后 ${Math.floor(maxLines / 2)} 行，共 ${lines.length} 行`));
  }

  // Changes section (if provided)
  if (config.changes && config.changes.length > 0) {
    elements.push(buildDivider());
    elements.push(...buildChangeSummary(config.changes));
  }

  // Actions section
  elements.push(buildDivider());
  elements.push(
    ...buildReviewActions(
      theme,
      config.approveAction || 'approve',
      config.rejectAction || 'reject',
      config.requestChangesAction || 'request_changes',
      config.showViewDetails !== false ? config.viewDetailsAction : undefined
    )
  );

  // Footer note
  if (config.footerNote) {
    elements.push(buildNote(config.footerNote));
  }

  return buildCard({
    header: {
      title: theme.title,
      template: theme.template,
      subtitle: config.subtitle,
    },
    elements,
  });
}

/**
 * Build a multi-item review card for batch approvals.
 *
 * @param title - Review title
 * @param items - Items to review
 * @param approveAllAction - Action value for approve all
 * @param rejectAllAction - Action value for reject all
 * @param theme - Theme to use
 * @returns Card object
 */
export function buildBatchReviewCard(
  title: string,
  items: Array<{ name: string; description?: string }>,
  approveAllAction = 'approve_all',
  rejectAllAction = 'reject_all',
  theme: ReviewCardConfig['theme'] = 'modern'
): BuiltCard {
  const themeConfig = getTheme(theme);
  const elements: CardElement[] = [];

  elements.push(buildDiv(`**${title}**`));
  elements.push(buildDiv(`共 ${items.length} 项待审批`));
  elements.push(buildDivider());

  // List items
  for (let i = 0; i < items.length && i < 10; i++) {
    const item = items[i];
    let itemText = `${i + 1}. ${item.name}`;
    if (item.description) {
      itemText += ` - ${item.description}`;
    }
    elements.push(buildDiv(itemText));
  }

  if (items.length > 10) {
    elements.push(buildNote(`... 还有 ${items.length - 10} 项`));
  }

  // Actions
  elements.push(buildDivider());
  elements.push(
    buildActionGroup([
      buildButton({
        text: `${themeConfig.approveText} (${items.length})`,
        value: approveAllAction,
        style: 'primary',
      }),
      buildButton({
        text: themeConfig.rejectText,
        value: rejectAllAction,
        style: 'danger',
      }),
    ])
  );

  return buildCard({
    header: {
      title: themeConfig.title,
      template: themeConfig.template,
    },
    elements,
  });
}

/**
 * Generate action prompts for review card.
 * Use these with send_interactive_message to handle user interactions.
 *
 * @param context - Context information (e.g., PR number, task name)
 * @param theme - Theme to use for prompt style
 * @returns Action prompt map
 *
 * @example
 * ```typescript
 * const actionPrompts = buildReviewActionPrompts('PR #123');
 * await send_interactive_message({
 *   card: reviewCard,
 *   actionPrompts,
 *   chatId: 'oc_xxx',
 * });
 * ```
 */
export function buildReviewActionPrompts(
  context: string,
  theme: ReviewCardConfig['theme'] = 'modern'
): Record<string, string> {
  const themeConfig = getTheme(theme);

  return {
    approve: `[用户操作] 用户${themeConfig.approveText}：${context}。请继续执行后续操作。`,
    reject: `[用户操作] 用户${themeConfig.rejectText}：${context}。请停止当前操作。`,
    request_changes: `[用户操作] 用户${themeConfig.requestChangesText}：${context}。请根据用户反馈进行修改。`,
    view_details: `[用户操作] 用户${themeConfig.viewDetailsText}：${context}。请展示详细信息。`,
    approve_all: `[用户操作] 用户批量批准：${context}。请继续执行后续操作。`,
    reject_all: `[用户操作] 用户批量拒绝：${context}。请停止所有操作。`,
  };
}
