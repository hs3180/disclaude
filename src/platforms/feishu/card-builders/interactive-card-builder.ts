/**
 * Feishu Interactive Card Builder.
 *
 * Provides builders for creating interactive cards with buttons,
 * menus, and other interactive components.
 *
 * @see https://open.feishu.cn/document/client-docs/bot-v3/card-message
 */

/**
 * Button style types.
 */
export type ButtonStyle = 'default' | 'primary' | 'danger';

/**
 * Button configuration.
 */
export interface ButtonConfig {
  /** Button text */
  text: string;
  /** Action value sent when clicked */
  value: string;
  /** Button style */
  style?: ButtonStyle;
  /** URL to open when clicked (optional) */
  url?: string;
}

/**
 * Menu option configuration.
 */
export interface MenuOptionConfig {
  /** Option text */
  text: string;
  /** Option value */
  value: string;
}

/**
 * Menu configuration.
 */
export interface MenuConfig {
  /** Placeholder text */
  placeholder: string;
  /** Action value sent when selected */
  value: string;
  /** Menu options */
  options: MenuOptionConfig[];
}

/**
 * Divider configuration.
 */
export interface DividerConfig {
  /** Whether to show divider */
  show?: boolean;
}

/**
 * Markdown configuration.
 */
export interface MarkdownConfig {
  /** Markdown content */
  content: string;
  /** Text size */
  textSize?: 'normal' | 'notation' | 'heading' | 'title';
}

/**
 * Card column configuration.
 */
export interface ColumnConfig {
  /** Column width ratio (1-6) */
  width?: number;
  /** Column vertical alignment */
  verticalAlign?: 'top' | 'center' | 'bottom';
  /** Elements in the column */
  elements: CardElement[];
}

/**
 * Plain text element (used inside note, etc.)
 */
export interface PlainTextElement {
  tag: 'plain_text';
  content: string;
}

/**
 * Card element types.
 */
export type CardElement =
  | { tag: 'div'; text: { tag: 'plain_text' | 'lark_md'; content: string } }
  | { tag: 'markdown'; content: string; text_align?: 'left' | 'center' | 'right' }
  | { tag: 'action'; actions: ActionElement[] }
  | { tag: 'hr' }
  | { tag: 'note'; elements: PlainTextElement[] }
  | { tag: 'img'; img_key: string; alt: { tag: 'plain_text'; content: string } }
  | { tag: 'column_set'; columns: ColumnConfig[] };

/**
 * Action element types.
 */
export type ActionElement = ButtonAction | MenuAction;

/**
 * Button click configuration for triggering callbacks.
 * Required for button clicks to trigger card.action.trigger events.
 */
export interface ButtonClick {
  tag: 'request';
  value: Record<string, string>;
}

/**
 * Button action element.
 */
export interface ButtonAction {
  tag: 'button';
  text: { tag: 'plain_text'; content: string };
  type: ButtonStyle;
  value: Record<string, string>;
  /** Click configuration required for triggering card.action.trigger events */
  click: ButtonClick;
  url?: string;
}

/**
 * Menu action element.
 */
export interface MenuAction {
  tag: 'select_static';
  placeholder: { tag: 'plain_text'; content: string };
  value: Record<string, string>;
  options: Array<{
    text: { tag: 'plain_text'; content: string };
    value: string;
  }>;
}

/**
 * Card header configuration.
 */
export interface CardHeaderConfig {
  /** Header title */
  title: string;
  /** Optional subtitle */
  subtitle?: string;
  /** Template color */
  template?: 'blue' | 'wathet' | 'turquoise' | 'green' | 'yellow' | 'orange' | 'red' | 'carmine' | 'violet' | 'purple' | 'indigo' | 'grey';
}

/**
 * Card configuration.
 */
export interface CardConfig {
  /** Card header (optional) */
  header?: CardHeaderConfig;
  /** Card elements */
  elements: CardElement[];
  /** Whether card can be dismissed */
  dismissible?: boolean;
}

/**
 * Built card structure for Feishu API.
 */
export interface BuiltCard {
  config: {
    wide_screen_mode: boolean;
  };
  header?: {
    title: PlainTextElement;
    template?: string;
    subtitle?: PlainTextElement;
  };
  elements: CardElement[];
}

/**
 * Build a button element.
 *
 * @param config - Button configuration
 * @returns Button action element
 *
 * @example
 * const button = buildButton({ text: 'Confirm', value: 'confirm', style: 'primary' });
 */
export function buildButton(config: ButtonConfig): ButtonAction {
  const buttonValue = { action: config.value };

  const button: ButtonAction = {
    tag: 'button',
    text: { tag: 'plain_text', content: config.text },
    type: config.style || 'default',
    value: buttonValue,
    // click field is required for triggering card.action.trigger events
    click: {
      tag: 'request',
      value: buttonValue,
    },
  };

  if (config.url) {
    button.url = config.url;
  }

  return button;
}

/**
 * Build a menu/select element.
 *
 * @param config - Menu configuration
 * @returns Menu action element
 *
 * @example
 * const menu = buildMenu({
 *   placeholder: 'Select an option',
 *   value: 'select_option',
 *   options: [
 *     { text: 'Option A', value: 'a' },
 *     { text: 'Option B', value: 'b' },
 *   ],
 * });
 */
export function buildMenu(config: MenuConfig): MenuAction {
  return {
    tag: 'select_static',
    placeholder: { tag: 'plain_text', content: config.placeholder },
    value: { action: config.value },
    options: config.options.map((opt) => ({
      text: { tag: 'plain_text', content: opt.text },
      value: opt.value,
    })),
  };
}

/**
 * Build a text div element.
 *
 * @param text - Text content
 * @param useMarkdown - Whether to use markdown formatting
 * @returns Div element
 */
export function buildDiv(text: string, useMarkdown = true): CardElement {
  return {
    tag: 'div',
    text: {
      tag: useMarkdown ? 'lark_md' : 'plain_text',
      content: text,
    },
  };
}

/**
 * Build a markdown element.
 *
 * @param content - Markdown content
 * @param align - Text alignment
 * @returns Markdown element
 */
export function buildMarkdown(content: string, align?: 'left' | 'center' | 'right'): CardElement {
  const element: CardElement = {
    tag: 'markdown',
    content,
  };
  if (align) {
    element.text_align = align;
  }
  return element;
}

/**
 * Build a horizontal rule (divider) element.
 *
 * @returns HR element
 */
export function buildDivider(): CardElement {
  return { tag: 'hr' };
}

/**
 * Build an action group element.
 *
 * @param actions - Action elements (buttons, menus, etc.)
 * @returns Action element
 *
 * @example
 * const actions = buildActionGroup([
 *   buildButton({ text: 'Yes', value: 'yes', style: 'primary' }),
 *   buildButton({ text: 'No', value: 'no', style: 'danger' }),
 * ]);
 */
export function buildActionGroup(actions: ActionElement[]): CardElement {
  return {
    tag: 'action',
    actions,
  };
}

/**
 * Build a note element (small text at bottom).
 *
 * @param text - Note text
 * @returns Note element
 */
export function buildNote(text: string): CardElement {
  return {
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content: text,
      },
    ],
  };
}

/**
 * Build a column set element.
 *
 * @param columns - Column configurations
 * @returns Column set element
 */
export function buildColumnSet(columns: ColumnConfig[]): CardElement {
  return {
    tag: 'column_set',
    columns: columns.map((col) => ({
      width: col.width,
      vertical_align: col.verticalAlign || 'center',
      elements: col.elements,
    })),
  };
}

/**
 * Build a complete interactive card.
 *
 * @param config - Card configuration
 * @returns Card object for Feishu API
 *
 * @example
 * const card = buildCard({
 *   header: { title: 'Confirmation', template: 'blue' },
 *   elements: [
 *     buildDiv('Are you sure you want to proceed?'),
 *     buildActionGroup([
 *       buildButton({ text: 'Confirm', value: 'confirm', style: 'primary' }),
 *       buildButton({ text: 'Cancel', value: 'cancel', style: 'danger' }),
 *     ]),
 *   ],
 * });
 */
export function buildCard(config: CardConfig): BuiltCard {
  // Build custom card structure without template
  const customCard: BuiltCard = {
    config: {
      wide_screen_mode: true,
    },
    elements: config.elements,
  };

  if (config.header) {
    customCard.header = {
      title: {
        tag: 'plain_text',
        content: config.header.title,
      },
      template: config.header.template || 'blue',
    };

    if (config.header.subtitle) {
      customCard.header.subtitle = {
        tag: 'plain_text',
        content: config.header.subtitle,
      };
    }
  }

  return customCard;
}

/**
 * Build a confirmation card with Yes/No buttons.
 *
 * @param title - Card title
 * @param message - Confirmation message
 * @param confirmValue - Value for confirm button
 * @param cancelValue - Value for cancel button
 * @returns Card object
 */
export function buildConfirmCard(
  title: string,
  message: string,
  confirmValue = 'confirm',
  cancelValue = 'cancel'
): BuiltCard {
  return buildCard({
    header: { title, template: 'blue' },
    elements: [
      buildDiv(message),
      buildActionGroup([
        buildButton({ text: 'Confirm', value: confirmValue, style: 'primary' }),
        buildButton({ text: 'Cancel', value: cancelValue, style: 'default' }),
      ]),
    ],
  });
}

/**
 * Build a selection card with menu.
 *
 * @param title - Card title
 * @param message - Selection message
 * @param placeholder - Menu placeholder
 * @param actionValue - Action value for the menu
 * @param options - Menu options
 * @returns Card object
 */
export function buildSelectionCard(
  title: string,
  message: string,
  placeholder: string,
  actionValue: string,
  options: MenuOptionConfig[]
): BuiltCard {
  return buildCard({
    header: { title, template: 'turquoise' },
    elements: [
      buildDiv(message),
      buildActionGroup([
        buildMenu({
          placeholder,
          value: actionValue,
          options,
        }),
      ]),
    ],
  });
}
