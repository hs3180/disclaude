/**
 * Feishu Interactive Card Builder.
 *
 * Provides builders for creating interactive cards with buttons,
 * menus, and other interactive components.
 *
 * @see https://open.feishu.cn/document/client-docs/bot-v3/card-message
 */
/**
 * Build a button element.
 *
 * @param config - Button configuration
 * @returns Button action element
 *
 * @example
 * const button = buildButton({ text: 'Confirm', value: 'confirm', style: 'primary' });
 */
export function buildButton(config) {
    const button = {
        tag: 'button',
        text: { tag: 'plain_text', content: config.text },
        type: config.style || 'default',
        value: { action: config.value },
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
export function buildMenu(config) {
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
export function buildDiv(text, useMarkdown = true) {
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
export function buildMarkdown(content, align) {
    const element = {
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
export function buildDivider() {
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
export function buildActionGroup(actions) {
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
export function buildNote(text) {
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
export function buildColumnSet(columns) {
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
export function buildCard(config) {
    // Build custom card structure without template
    const customCard = {
        config: {
            wide_screen_mode: true,
            ...(config.dismissible !== undefined && { dismissible: config.dismissible }),
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
export function buildConfirmCard(title, message, confirmValue = 'confirm', cancelValue = 'cancel') {
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
export function buildSelectionCard(title, message, placeholder, actionValue, options) {
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
