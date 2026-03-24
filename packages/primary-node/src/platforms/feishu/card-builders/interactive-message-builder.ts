/**
 * Interactive Message Builder.
 *
 * Builds interactive cards from raw parameters (question, options, title, context)
 * for the sendInteractive IPC flow. Primary Node owns the full card building lifecycle.
 *
 * Unlike interactive-card-builder.ts (which uses { action: value } object format for
 * button values), this builder uses plain string values for compatibility with the
 * action prompt registration system.
 *
 * @module card-builders/interactive-message-builder
 */

/**
 * Interactive message option configuration.
 */
export interface InteractiveOption {
  /** Button display text */
  text: string;
  /** Action value (plain string, used as action prompt key) */
  value: string;
  /** Button style */
  type?: 'primary' | 'default' | 'danger';
}

/**
 * Parameters for building an interactive message card.
 */
export interface InteractiveMessageParams {
  /** The question or main content to display */
  question: string;
  /** Button options for user interaction */
  options: InteractiveOption[];
  /** Card title (defaults to '交互消息') */
  title?: string;
  /** Optional context shown above the question */
  context?: string;
}

/**
 * Action prompt map: button value → prompt template.
 */
export type ActionPromptMap = Record<string, string>;

/**
 * Default prompt template for action prompts.
 * Placeholders: {text} = button text, {value} = button value
 */
const DEFAULT_PROMPT_TEMPLATE = '[用户操作] 用户选择了「{text}」';

/**
 * Build an interactive card from raw parameters.
 *
 * Produces a Feishu card JSON structure with:
 * - Optional context section
 * - Question as markdown content
 * - Divider
 * - Action buttons
 *
 * @param params - Raw parameters for the interactive message
 * @returns Card object compatible with Feishu API
 *
 * @example
 * const card = buildInteractiveCard({
 *   question: 'Which option do you prefer?',
 *   options: [
 *     { text: '✅ Approve', value: 'approve', type: 'primary' },
 *     { text: '❌ Reject', value: 'reject', type: 'danger' },
 *   ],
 *   title: 'Code Review',
 *   context: 'PR #123 needs your approval',
 * });
 */
export function buildInteractiveCard(params: InteractiveMessageParams): Record<string, unknown> {
  const { question, options, title, context } = params;
  const cardTitle = title ?? '交互消息';

  const elements: unknown[] = [];

  // Optional context section
  if (context) {
    elements.push({ tag: 'markdown', content: context });
  }

  // Main question
  elements.push({ tag: 'markdown', content: question });

  // Divider
  elements.push({ tag: 'hr' });

  // Action buttons
  const actionButtons = options.map((opt) => ({
    tag: 'button' as const,
    text: { tag: 'plain_text' as const, content: opt.text },
    value: opt.value,
    type: opt.type ?? 'default',
  }));

  elements.push({
    tag: 'action',
    actions: actionButtons,
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: cardTitle },
      template: 'blue',
    },
    elements,
  };
}

/**
 * Build action prompts from options.
 *
 * Generates a map of button values to prompt templates. When the user
 * clicks a button, the corresponding prompt is used to generate a
 * message that the agent receives.
 *
 * @param options - Button options
 * @param customPrompts - Optional custom prompts (overrides default for matching values)
 * @param template - Optional custom template string with {text} and {value} placeholders
 * @returns Action prompt map
 *
 * @example
 * const prompts = buildActionPrompts([
 *   { text: '✅ Approve', value: 'approve' },
 *   { text: '❌ Reject', value: 'reject' },
 * ]);
 * // Result:
 * {
 *   approve: '[用户操作] 用户选择了「✅ Approve」',
 *   reject: '[用户操作] 用户选择了「❌ Reject」',
 * }
 */
export function buildActionPrompts(
  options: InteractiveOption[],
  customPrompts?: ActionPromptMap,
  template?: string
): ActionPromptMap {
  const promptTemplate = template ?? DEFAULT_PROMPT_TEMPLATE;
  const prompts: ActionPromptMap = {};

  for (const opt of options) {
    // Custom prompts take precedence
    if (customPrompts && customPrompts[opt.value]) {
      prompts[opt.value] = customPrompts[opt.value];
    } else {
      prompts[opt.value] = promptTemplate
        .replace('{text}', opt.text)
        .replace('{value}', opt.value);
    }
  }

  return prompts;
}
