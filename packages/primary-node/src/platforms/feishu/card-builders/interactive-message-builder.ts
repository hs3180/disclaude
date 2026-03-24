/**
 * Interactive Message Builder.
 *
 * High-level builder for creating interactive message cards from raw parameters.
 * Used by Primary Node's sendInteractive IPC handler to build cards
 * that would otherwise need to be constructed by MCP tools.
 *
 * Part of Issue #1571 (Phase 2 of IPC Layer Responsibility Refactoring).
 * Primary Node owns the full card building lifecycle.
 *
 * @module primary-node/card-builders/interactive-message-builder
 */

import {
  buildMarkdown,
  buildDivider,
  buildCard,
  type CardConfig,
  type BuiltCard,
  type CardElement,
  type ButtonStyle,
} from './interactive-card-builder.js';

/**
 * Interactive message option configuration.
 */
export interface InteractiveOption {
  /** Button text */
  text: string;
  /** Action value sent when clicked */
  value: string;
  /** Button style */
  type?: ButtonStyle;
}

/**
 * Parameters for building an interactive message card.
 */
export interface InteractiveMessageParams {
  /** The question or main content to display */
  question: string;
  /** Available options as clickable buttons */
  options: InteractiveOption[];
  /** Card title */
  title?: string;
  /** Optional context text displayed above the question */
  context?: string;
}

/**
 * Build an interactive message card from raw parameters.
 *
 * Creates a Feishu interactive card with:
 * - Optional context section (markdown)
 * - Question section (markdown)
 * - Horizontal divider
 * - Action buttons from options (using plain string values for Feishu callbacks)
 *
 * Note: Unlike `interactive-card-builder.ts`'s `buildButton()` which wraps values
 * in `{ action: value }`, this builder uses plain string values directly, matching
 * the Feishu interactive card callback format used by the IPC sendInteractive flow.
 *
 * @param params - Interactive message parameters
 * @returns Built card structure for Feishu API
 *
 * @example
 * const card = buildInteractiveCard({
 *   question: 'Which option do you prefer?',
 *   options: [
 *     { text: 'Option A', value: 'a', type: 'primary' },
 *     { text: 'Option B', value: 'b' },
 *   ],
 *   title: 'Choose an option',
 *   context: 'Please select one of the following:',
 * });
 */
export function buildInteractiveCard(params: InteractiveMessageParams): BuiltCard {
  const { question, options, title, context } = params;

  // Build card elements directly (not using buildActionGroup to avoid
  // type mismatch: IPC sendInteractive uses plain string values for
  // button callbacks, while interactive-card-builder wraps in Record<string, string>)
  const elements: CardElement[] = [];

  // Add context section if provided
  if (context) {
    elements.push(buildMarkdown(context));
  }

  // Add question
  elements.push(buildMarkdown(question));

  // Add divider between content and actions
  elements.push(buildDivider());

  // Build action buttons from options (plain string values for Feishu callbacks)
  // Note: Feishu API accepts both string and object values for button actions.
  // The IPC sendInteractive flow uses plain string values for simplicity.
  const actionButtons = options.map((opt) => ({
    tag: 'button' as const,
    text: { tag: 'plain_text' as const, content: opt.text },
    value: opt.value,
    type: (opt.type ?? 'default') as ButtonStyle,
  }));

  elements.push({
    tag: 'action',
    actions: actionButtons,
  } as unknown as CardElement);

  const cardConfig: CardConfig = {
    elements,
  };

  if (title) {
    cardConfig.header = { title, template: 'blue' };
  }

  return buildCard(cardConfig);
}

/**
 * Generate action prompts from interactive options.
 *
 * Creates a map of action values to prompt templates that describe
 * what happens when each button is clicked. Used by Primary Node
 * to register action prompts for interactive card callbacks.
 *
 * @param options - Interactive options
 * @param template - Optional template string with {{text}} placeholder.
 *                   Defaults to "[用户操作] 用户选择了「{{text}}」"
 * @returns Map of action values to prompt strings
 *
 * @example
 * const prompts = buildActionPrompts([
 *   { text: 'Confirm', value: 'confirm' },
 *   { text: 'Cancel', value: 'cancel' },
 * ]);
 * // Result:
 * // {
 * //   confirm: "[用户操作] 用户选择了「Confirm」",
 * //   cancel: "[用户操作] 用户选择了「Cancel」",
 * // }
 *
 * @example
 * const prompts = buildActionPrompts(
 *   [{ text: 'Approve', value: 'approve' }],
 *   "[用户操作] 用户点击了「{{text}}」按钮，请继续执行任务。"
 * );
 * // Result: { approve: "[用户操作] 用户点击了「Approve」按钮，请继续执行任务。" }
 */
export function buildActionPrompts(
  options: InteractiveOption[],
  template = '[用户操作] 用户选择了「{{text}}」'
): Record<string, string> {
  const prompts: Record<string, string> = {};

  for (const opt of options) {
    prompts[opt.value] = template.replace('{{text}}', opt.text);
  }

  return prompts;
}
