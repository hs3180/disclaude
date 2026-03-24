/**
 * Interactive Message Builder.
 *
 * High-level builders for creating interactive messages with action prompts.
 * These builders encapsulate the full lifecycle of building a Feishu card
 * from raw parameters (question, options, title) and generating action prompts.
 *
 * Phase 2 of IPC Layer Responsibility Refactoring (#1568):
 * - buildInteractiveCard(): Builds a Feishu card from raw parameters
 * - buildActionPrompts(): Generates action prompt map from options
 *
 * @module primary-node/card-builders/interactive-message-builder
 */

import {
  buildButton,
  buildCard,
  buildDiv,
  buildDivider,
  buildActionGroup,
  type ButtonStyle,
  type BuiltCard,
} from './interactive-card-builder.js';

/**
 * Option configuration for interactive messages.
 */
export interface InteractiveOption {
  /** Button display text */
  text: string;
  /** Action value sent when clicked */
  value: string;
  /** Button style */
  style?: ButtonStyle;
  /** Action prompt template (supports {{actionText}}, {{actionValue}}, {{actionType}}) */
  prompt?: string;
}

/**
 * Parameters for building an interactive card.
 */
export interface InteractiveCardParams {
  /** Question or main content to display */
  question: string;
  /** Available options as buttons */
  options: InteractiveOption[];
  /** Card header title (optional) */
  title?: string;
  /** Card header template color (default: 'blue') */
  template?: 'blue' | 'wathet' | 'turquoise' | 'green' | 'yellow' | 'orange' | 'red' | 'carmine' | 'violet' | 'purple' | 'indigo' | 'grey';
  /** Additional markdown content to display before the question */
  content?: string;
}

/**
 * Result of building an interactive card.
 */
export interface InteractiveCardResult {
  /** The built Feishu card JSON */
  card: BuiltCard;
  /** Map of action values to prompt templates */
  actionPrompts: Record<string, string>;
}

/**
 * Default prompt template for action prompts.
 * Can include placeholders: {{actionText}}, {{actionValue}}, {{actionType}}
 */
const DEFAULT_PROMPT_TEMPLATE = '[用户操作] 用户点击了「{{actionText}}」按钮';

/**
 * Build action prompts map from options.
 *
 * Generates a map of action values to prompt templates. If an option
 * has a custom prompt, it is used; otherwise, the default template is applied.
 *
 * @param options - Array of interactive options
 * @param defaultTemplate - Default prompt template (optional)
 * @returns Map of action values to prompt templates
 *
 * @example
 * ```typescript
 * const prompts = buildActionPrompts([
 *   { text: 'Confirm', value: 'confirm', prompt: 'User confirmed.' },
 *   { text: 'Cancel', value: 'cancel' },
 * ]);
 * // Result:
 * // {
 * //   confirm: 'User confirmed.',
 * //   cancel: '[用户操作] 用户点击了「Cancel」按钮',
 * // }
 * ```
 */
export function buildActionPrompts(
  options: InteractiveOption[],
  defaultTemplate = DEFAULT_PROMPT_TEMPLATE
): Record<string, string> {
  const prompts: Record<string, string> = {};

  for (const option of options) {
    const template = option.prompt ?? defaultTemplate;
    prompts[option.value] = template
      .replace(/\{\{actionText\}\}/g, option.text)
      .replace(/\{\{actionValue\}\}/g, option.value);
  }

  return prompts;
}

/**
 * Build an interactive card from raw parameters.
 *
 * Creates a complete Feishu card with header, content, and action buttons
 * from simple parameters. This is the Primary Node's equivalent of the
 * removed MCP Server's `buildQuestionCard()` function.
 *
 * @param params - Interactive card parameters
 * @returns Card and action prompts
 *
 * @example
 * ```typescript
 * const result = buildInteractiveCard({
 *   question: 'Which option do you prefer?',
 *   options: [
 *     { text: 'Option A', value: 'a', style: 'primary' },
 *     { text: 'Option B', value: 'b' },
 *   ],
 *   title: 'Choose an Option',
 * });
 * // result.card: Feishu card JSON
 * // result.actionPrompts: { a: '...', b: '...' }
 * ```
 */
export function buildInteractiveCard(params: InteractiveCardParams): InteractiveCardResult {
  const { question, options, title, template = 'blue', content } = params;

  const elements: BuiltCard['elements'] = [];

  // Add optional content section
  if (content) {
    elements.push(buildDiv(content));
  }

  // Add question
  elements.push(buildDiv(question));

  // Add divider before actions
  if (options.length > 0) {
    elements.push(buildDivider());
  }

  // Build action buttons
  const buttons = options.map((option) =>
    buildButton({
      text: option.text,
      value: option.value,
      style: option.style,
    })
  );
  elements.push(buildActionGroup(buttons));

  // Build the card
  const card = buildCard({
    header: title ? { title, template } : undefined,
    elements,
  });

  // Build action prompts
  const actionPrompts = buildActionPrompts(options);

  return { card, actionPrompts };
}
