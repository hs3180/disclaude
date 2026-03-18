/**
 * Feishu card validation utilities.
 *
 * @module mcp/utils/card-validator
 */

/**
 * Check if content is a valid Feishu interactive card structure.
 */
export function isValidFeishuCard(content: Record<string, unknown>): boolean {
  return (
    typeof content === 'object' &&
    content !== null &&
    'config' in content &&
    'header' in content &&
    'elements' in content &&
    Array.isArray(content.elements) &&
    typeof content.header === 'object' &&
    content.header !== null &&
    'title' in content.header
  );
}

/**
 * Get detailed validation error for an invalid card.
 *
 * Issue #1355: Improved error messages to help AI agents understand and fix
 * parameter format issues (e.g., passing string instead of object).
 */
export function getCardValidationError(content: unknown): string {
  if (content === null) {
    return 'card is null - must be an object with config/header/elements';
  }
  if (typeof content !== 'object') {
    return `card is ${typeof content} - must be an object with config/header/elements`;
  }
  if (Array.isArray(content)) {
    return 'card is an array - must be an object with config/header/elements, not an array';
  }

  const obj = content as Record<string, unknown>;
  const missing: string[] = [];
  const wrongTypes: string[] = [];

  if (!('config' in obj)) {
    missing.push('config');
  } else if (typeof obj.config !== 'object' || obj.config === null) {
    wrongTypes.push('config must be an object');
  }

  if (!('header' in obj)) {
    missing.push('header');
  } else if (typeof obj.header !== 'object' || obj.header === null) {
    wrongTypes.push('header must be an object with title');
  }

  if (!('elements' in obj)) {
    missing.push('elements');
  } else if (!Array.isArray(obj.elements)) {
    wrongTypes.push('elements must be an array');
  }

  if (missing.length > 0) {
    return `missing required fields: ${missing.join(', ')}`;
  }

  if (wrongTypes.length > 0) {
    return wrongTypes.join('; ');
  }

  if (typeof obj.header === 'object' && obj.header !== null && !('title' in obj.header)) {
    return 'header.title is missing';
  }

  return 'invalid card structure - ensure card has config (object), header (object with title), and elements (array)';
}
