/**
 * Interactive Message Builder.
 *
 * Builds interactive cards from raw parameters (question, options, title, context)
 * for the sendInteractive REST API flow. Primary Node owns the full card building lifecycle.
 *
 * Unlike interactive-card-builder.ts (which uses { action: value } object format for
 * button values), this builder uses plain string values for compatibility with the
 * action prompt registration system.
 *
 * @module card-builders/interactive-message-builder
 */
import { normalizeMarkdownLineBreaks } from './content-builder.js';
/**
 * Default prompt template for action prompts.
 * Placeholders: {text} = button text, {value} = button value
 */
const DEFAULT_PROMPT_TEMPLATE = '[用户操作] 用户选择了「{text}」';
/**
 * Validate InteractiveMessageParams.
 * Called at REST API boundary where data comes from an external process (MCP Server).
 *
 * @param params - Raw params to validate
 * @returns Error message if invalid, or null if valid
 */
export function validateInteractiveParams(params) {
    if (!params || typeof params !== 'object') {
        return 'params must be a non-null object';
    }
    const p = params;
    if (typeof p.question !== 'string' || p.question.trim().length === 0) {
        return 'params.question must be a non-empty string';
    }
    if (!Array.isArray(p.options) || p.options.length === 0) {
        return 'params.options must be a non-empty array';
    }
    for (let i = 0; i < p.options.length; i++) {
        const opt = p.options[i];
        if (typeof opt.text !== 'string' || opt.text.trim().length === 0) {
            return `params.options[${i}].text must be a non-empty string`;
        }
        if (typeof opt.value !== 'string' || opt.value.trim().length === 0) {
            return `params.options[${i}].value must be a non-empty string`;
        }
        if (opt.type !== undefined && !['primary', 'default', 'danger'].includes(opt.type)) {
            return `params.options[${i}].type must be one of: primary, default, danger`;
        }
    }
    if (p.title !== undefined && typeof p.title !== 'string') {
        return 'params.title must be a string if provided';
    }
    if (p.context !== undefined && typeof p.context !== 'string') {
        return 'params.context must be a string if provided';
    }
    return null;
}
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
export function buildInteractiveCard(params) {
    const { question, options, title, context } = params;
    const cardTitle = title ?? '交互消息';
    const elements = [];
    // Optional context section
    if (context) {
        elements.push({ tag: 'markdown', content: normalizeMarkdownLineBreaks(context) });
    }
    // Main question
    elements.push({ tag: 'markdown', content: normalizeMarkdownLineBreaks(question) });
    // Divider
    elements.push({ tag: 'hr' });
    // Action buttons
    const actionButtons = options.map((opt) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: opt.text },
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
export function buildActionPrompts(options, customPrompts, template) {
    const promptTemplate = template ?? DEFAULT_PROMPT_TEMPLATE;
    const prompts = {};
    for (const opt of options) {
        // Custom prompts take precedence
        if (customPrompts && customPrompts[opt.value]) {
            prompts[opt.value] = customPrompts[opt.value];
        }
        else {
            prompts[opt.value] = promptTemplate.replace('{text}', opt.text).replace('{value}', opt.value);
        }
    }
    return prompts;
}
