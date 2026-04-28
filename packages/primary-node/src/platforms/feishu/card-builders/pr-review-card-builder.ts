/**
 * PR Review Card Builder.
 *
 * Builds Feishu Interactive Card templates for the PR Scanner system.
 * These templates define the card layouts and action prompts for:
 * - PR Detail Card (initial send to new discussion group)
 * - PR Merged Notification Card
 * - PR Closed Notification Card
 *
 * The templates produce Feishu-compatible card JSON using the existing
 * card builder infrastructure from interactive-card-builder.ts.
 *
 * Issue #2983: PR Review interactive card template design.
 * Parent: #2945 — Simplified temporary conversation design.
 *
 * @module card-builders/pr-review-card-builder
 */

import type { ActionPromptMap } from './interactive-message-builder.js';
import {
  buildCard,
  buildDiv,
  buildDivider,
  buildNote,
  type BuiltCard,
  type CardElement,
  type ButtonStyle,
} from './interactive-card-builder.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * PR metadata for building the detail card.
 * Fields are populated from `gh pr view --json` output.
 */
export interface PrDetailCardParams {
  /** PR number */
  prNumber: number;
  /** PR title */
  title: string;
  /** PR author login */
  author: string;
  /** Head branch name */
  headRef: string;
  /** Base branch name */
  baseRef: string;
  /** Lines added */
  additions: number;
  /** Lines deleted */
  deletions: number;
  /** Number of changed files */
  changedFiles: number;
  /** PR body/description (optional, first 500 chars used) */
  body?: string;
  /** AI-generated change summary (optional, from `gh pr diff` analysis) */
  changeSummary?: string;
}

/**
 * Complete payload for a PR review card.
 * Includes both the Feishu card JSON and action prompts for button interactions.
 */
export interface PrReviewCardPayload {
  /** Feishu Interactive Card JSON */
  card: BuiltCard;
  /** Action prompt map: button value → prompt template */
  actionPrompts: ActionPromptMap;
}

/**
 * Button definition with plain-string value for Feishu API compatibility.
 * The Feishu card action callback sends `action.value` as a string.
 */
interface FeishuButton {
  tag: 'button';
  text: { tag: 'plain_text'; content: string };
  value: string;
  type: ButtonStyle;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Truncate text to a maximum length with ellipsis.
 */
function truncate(text: string, maxLength: number): string {
  if (!text || text.length <= maxLength) {return text ?? '';}
  return `${text.substring(0, maxLength)  }...`;
}

/**
 * Build an action group element with plain-string button values.
 *
 * The `interactive-card-builder.ts` `buildButton()` wraps values in
 * `{ action: value }`, but the Feishu card action callback sends
 * `action.value` as a plain string. This helper builds buttons with
 * plain-string values that are compatible with the action prompt system.
 */
function buildFeishuButtonGroup(buttons: FeishuButton[]): CardElement {
  return {
    tag: 'action',
    actions: buttons,
  } as unknown as CardElement;
}

// ---------------------------------------------------------------------------
// PR Detail Card
// ---------------------------------------------------------------------------

/**
 * Build the PR detail card for initial send to a new discussion group.
 *
 * Layout:
 * ```
 * ┌─────────────────────────────────┐
 * │ PR Review #{number}             │  ← blue header
 * ├─────────────────────────────────┤
 * │ 📝 标题: {title}               │
 * │ 👤 作者: {author}               │
 * │ 🔀 分支: {head} → {base}       │
 * │ 📏 变更: +{add} -{del} (files)  │
 * ├─────────────────────────────────┤
 * │ 📋 描述:                        │  (from PR body)
 * │ {body 前500字}                  │
 * ├─────────────────────────────────┤
 * │ 🔍 变更摘要:                    │  (AI-generated, optional)
 * │ • 核心变更点1                    │
 * ├─────────────────────────────────┤
 * │ [✅ Approve] [❌ Close] [💬 Review] │
 * ├─────────────────────────────────┤
 * │ 🔗 View PR: https://...         │
 * └─────────────────────────────────┘
 * ```
 *
 * @param params - PR metadata
 * @returns Card JSON and action prompts
 */
export function buildPrDetailCard(params: PrDetailCardParams): PrReviewCardPayload {
  const {
    prNumber, title, author,
    headRef, baseRef,
    additions, deletions, changedFiles,
    body, changeSummary,
  } = params;

  const elements: CardElement[] = [];

  // 1. PR metadata section
  elements.push(buildDiv(
    `📝 **标题**: ${title}\n`
    + `👤 **作者**: ${author}\n`
    + `🔀 **分支**: ${headRef} → ${baseRef}\n`
    + `📏 **变更**: +${additions} -${deletions} (${changedFiles} files)`
  ));
  elements.push(buildDivider());

  // 2. Description section (from PR body)
  if (body && body.trim().length > 0) {
    elements.push(buildDiv(`📋 **描述**:\n${truncate(body.trim(), 500)}`));
    elements.push(buildDivider());
  }

  // 3. Change summary section (AI-generated from gh pr diff)
  if (changeSummary && changeSummary.trim().length > 0) {
    elements.push(buildDiv(`🔍 **变更摘要**:\n${changeSummary.trim()}`));
    elements.push(buildDivider());
  }

  // 4. Action buttons: Approve, Close, Review
  elements.push(buildFeishuButtonGroup([
    { tag: 'button', text: { tag: 'plain_text', content: '✅ Approve' }, value: 'approve', type: 'primary' },
    { tag: 'button', text: { tag: 'plain_text', content: '❌ Close' }, value: 'close', type: 'danger' },
    { tag: 'button', text: { tag: 'plain_text', content: '💬 Review' }, value: 'review', type: 'default' },
  ]));

  // 5. Footer note with PR link
  elements.push(buildNote(`🔗 View PR: https://github.com/hs3180/disclaude/pull/${prNumber}`));

  const card = buildCard({
    header: { title: `PR Review #${prNumber}`, template: 'blue' },
    elements,
  });

  const actionPrompts: ActionPromptMap = {
    approve:
      `[用户操作] 用户批准合并 PR #${prNumber}。请执行:\n`
      + '1. 检查 CI 状态是否通过\n'
      + `2. 执行 \`gh pr review ${prNumber} --repo hs3180/disclaude --approve\`\n`
      + '3. 报告执行结果',
    close:
      `[用户操作] 用户关闭 PR #${prNumber}。请执行 \`gh pr close ${prNumber} --repo hs3180/disclaude\` 并报告结果。`,
    review:
      `[用户操作] 用户请求深度 Review PR #${prNumber}。请执行 \`gh pr diff ${prNumber} --repo hs3180/disclaude\` 后进行详细代码审查，将结果发送到当前群。`,
  };

  return { card, actionPrompts };
}

// ---------------------------------------------------------------------------
// PR State Change Notification Cards
// ---------------------------------------------------------------------------

/**
 * Build the PR merged notification card.
 *
 * Sent to the discussion group when the PR has been merged.
 * Includes a "解散群" (Disband Group) button for user-initiated cleanup.
 *
 * Layout:
 * ```
 * ┌─────────────────────────────────┐
 * │ ✅ PR #{number} has been merged  │  ← green header
 * ├─────────────────────────────────┤
 * │ [解散群]                         │
 * └─────────────────────────────────┘
 * ```
 *
 * @param prNumber - PR number
 * @param chatId - Discussion group chat ID (used in action prompt)
 * @returns Card JSON and action prompts
 */
export function buildPrMergedNotificationCard(
  prNumber: number,
  chatId: string,
): PrReviewCardPayload {
  const elements: CardElement[] = [];

  elements.push(buildFeishuButtonGroup([
    { tag: 'button', text: { tag: 'plain_text', content: '解散群' }, value: 'disband', type: 'danger' },
  ]));

  const card = buildCard({
    header: { title: `✅ PR #${prNumber} has been merged`, template: 'green' },
    elements,
  });

  const actionPrompts: ActionPromptMap = {
    disband:
      `[用户操作] 用户确认解散 PR #${prNumber} 讨论群。请执行:\n`
      + `1. lark-cli im chat disband --chat_id ${chatId}\n`
      + `2. 更新 workspace/pr-chat-mapping.json 将 pr-${prNumber} 的 status 改为 closed`,
  };

  return { card, actionPrompts };
}

/**
 * Build the PR closed (without merge) notification card.
 *
 * Sent to the discussion group when the PR has been closed without merging.
 * Includes a "解散群" (Disband Group) button for user-initiated cleanup.
 *
 * Layout:
 * ```
 * ┌─────────────────────────────────┐
 * │ ❌ PR #{number} has been closed  │  ← red header
 * ├─────────────────────────────────┤
 * │ [解散群]                         │
 * └─────────────────────────────────┘
 * ```
 *
 * @param prNumber - PR number
 * @param chatId - Discussion group chat ID (used in action prompt)
 * @returns Card JSON and action prompts
 */
export function buildPrClosedNotificationCard(
  prNumber: number,
  chatId: string,
): PrReviewCardPayload {
  const elements: CardElement[] = [];

  elements.push(buildFeishuButtonGroup([
    { tag: 'button', text: { tag: 'plain_text', content: '解散群' }, value: 'disband', type: 'danger' },
  ]));

  const card = buildCard({
    header: { title: `❌ PR #${prNumber} has been closed without merge`, template: 'red' },
    elements,
  });

  const actionPrompts: ActionPromptMap = {
    disband:
      `[用户操作] 用户确认解散 PR #${prNumber} 讨论群。请执行:\n`
      + `1. lark-cli im chat disband --chat_id ${chatId}\n`
      + `2. 更新 workspace/pr-chat-mapping.json 将 pr-${prNumber} 的 status 改为 closed`,
  };

  return { card, actionPrompts };
}
