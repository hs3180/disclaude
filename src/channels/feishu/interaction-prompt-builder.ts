/**
 * Interaction event to prompt converter.
 *
 * Converts Feishu card interaction events into human-readable prompts
 * that the agent can process naturally.
 *
 * @module channels/feishu/interaction-prompt-builder
 */

import type { FeishuCardAction } from '../../types/platform.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('InteractionPromptBuilder');

/**
 * Action types supported by Feishu interactive cards.
 */
export type FeishuActionType =
  | 'button'           // Button click
  | 'select_static'    // Static dropdown selection
  | 'select_person'    // Person picker selection
  | 'input'            // Input field submission
  | 'date_picker'      // Date picker selection
  | 'time_picker'      // Time picker selection
  | 'datetime_picker'  // DateTime picker selection
  | 'overflow'         // Overflow menu selection
  | 'collapsible'      // Collapsible section toggle
  | 'form';            // Form submission

/**
 * Context for building interaction prompts.
 */
export interface InteractionContext {
  /** The action that was performed */
  action: FeishuCardAction;
  /** The message ID of the card */
  messageId: string;
  /** The chat ID */
  chatId: string;
  /** The user who performed the action */
  userId?: string;
  /** Whether this was a pending interaction that was resolved */
  wasPendingInteraction?: boolean;
}

/**
 * Build a prompt message from a card interaction event.
 *
 * @param context - The interaction context
 * @returns A human-readable prompt string
 */
export function buildInteractionPrompt(context: InteractionContext): string {
  const { action, wasPendingInteraction } = context;
  const actionType = action.type as FeishuActionType;
  const actionValue = action.value;
  const actionText = action.text || action.value;

  logger.debug({ actionType, actionValue, actionText }, 'Building interaction prompt');

  // Build prompt based on action type
  switch (actionType) {
    case 'button':
      return buildButtonPrompt(actionText, actionValue, wasPendingInteraction);

    case 'select_static':
    case 'overflow':
      return buildSelectionPrompt(actionText, actionValue);

    case 'select_person':
      return buildPersonSelectionPrompt(actionText, actionValue);

    case 'input':
    case 'form':
      return buildInputPrompt(actionText, actionValue);

    case 'date_picker':
      return buildDatePrompt(actionText, actionValue);

    case 'time_picker':
      return buildTimePrompt(actionText, actionValue);

    case 'datetime_picker':
      return buildDateTimePrompt(actionText, actionValue);

    case 'collapsible':
      return buildCollapsiblePrompt(actionText, actionValue);

    default:
      // Fallback for unknown action types
      return buildGenericPrompt(actionText, actionValue, actionType);
  }
}

/**
 * Build prompt for button click.
 */
function buildButtonPrompt(
  buttonText: string,
  buttonValue: string,
  wasPending?: boolean
): string {
  // Use Chinese for better user experience
  const prefix = wasPending
    ? '[用户操作]'
    : '[用户操作]';

  // Check for common action patterns
  const lowerValue = buttonValue.toLowerCase();

  if (lowerValue === 'confirm' || lowerValue === '确认' || lowerValue === 'yes') {
    return `${prefix} 用户点击了「${buttonText}」按钮，确认执行操作。请继续执行任务。`;
  }

  if (lowerValue === 'cancel' || lowerValue === '取消' || lowerValue === 'no') {
    return `${prefix} 用户点击了「${buttonText}」按钮，取消操作。请根据此决定继续。`;
  }

  if (lowerValue === 'dismiss' || lowerValue === '关闭' || lowerValue === 'ignore') {
    return `${prefix} 用户点击了「${buttonText}」按钮，关闭了提示。`;
  }

  // Generic button prompt
  return `${prefix} 用户点击了「${buttonText}」按钮。请根据此操作继续执行任务。`;
}

/**
 * Build prompt for selection action.
 */
function buildSelectionPrompt(selectedText: string, selectedValue: string): string {
  return `[用户操作] 用户选择了「${selectedText}」选项（值：${selectedValue}）。请根据此选择继续执行任务。`;
}

/**
 * Build prompt for person selection.
 */
function buildPersonSelectionPrompt(personName: string, personId: string): string {
  return `[用户操作] 用户选择了人员「${personName}」。请根据此选择继续执行任务。`;
}

/**
 * Build prompt for input/form submission.
 */
function buildInputPrompt(inputText: string, inputValue: string): string {
  if (inputValue && inputValue.trim()) {
    return `[用户操作] 用户提交了输入：「${inputValue}」。请根据此输入继续执行任务。`;
  }
  return `[用户操作] 用户提交了表单。请根据提交内容继续执行任务。`;
}

/**
 * Build prompt for date selection.
 */
function buildDatePrompt(dateText: string, dateValue: string): string {
  return `[用户操作] 用户选择了日期「${dateValue}」。请根据此日期继续执行任务。`;
}

/**
 * Build prompt for time selection.
 */
function buildTimePrompt(timeText: string, timeValue: string): string {
  return `[用户操作] 用户选择了时间「${timeValue}」。请根据此时间继续执行任务。`;
}

/**
 * Build prompt for datetime selection.
 */
function buildDateTimePrompt(datetimeText: string, datetimeValue: string): string {
  return `[用户操作] 用户选择了日期时间「${datetimeValue}」。请根据此日期时间继续执行任务。`;
}

/**
 * Build prompt for collapsible toggle.
 */
function buildCollapsiblePrompt(sectionText: string, isExpanded: string): string {
  const state = isExpanded === 'true' || isExpanded === '1' ? '展开' : '收起';
  return `[用户操作] 用户${state}了「${sectionText}」部分。`;
}

/**
 * Build generic prompt for unknown action types.
 */
function buildGenericPrompt(text: string, value: string, actionType: string): string {
  return `[用户操作] 用户执行了 ${actionType} 操作：${text || value}。请根据此操作继续执行任务。`;
}

/**
 * Interaction prompt templates for different scenarios.
 */
export const INTERACTION_PROMPT_TEMPLATES = {
  /**
   * Template for confirmation dialogs.
   */
  confirm: {
    confirm: '[用户操作] 用户确认了操作。请继续执行。',
    cancel: '[用户操作] 用户取消了操作。',
  },

  /**
   * Template for selection dialogs.
   */
  selection: {
    selected: '[用户操作] 用户选择了「{option}」。请根据此选择继续执行。',
  },

  /**
   * Template for input collection.
   */
  input: {
    submitted: '[用户操作] 用户提交了：「{input}」。请根据此输入继续执行。',
    empty: '[用户操作] 用户提交了空输入。',
  },

  /**
   * Template for multi-step workflows.
   */
  workflow: {
    next: '[用户操作] 用户点击了「下一步」。请继续工作流。',
    back: '[用户操作] 用户点击了「上一步」。请返回上一步骤。',
    skip: '[用户操作] 用户跳过了当前步骤。',
    done: '[用户操作] 用户完成了操作。',
  },
} as const;

/**
 * Format a template with values.
 */
export function formatTemplate(
  template: string,
  values: Record<string, string>
): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replace(`{${key}}`, value);
  }
  return result;
}
