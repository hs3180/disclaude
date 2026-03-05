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
 */
export function getCardValidationError(content: unknown): string {
  if (content === null) {
    return 'content is null';
  }
  if (typeof content !== 'object') {
    return `content is ${typeof content}, expected object`;
  }
  if (Array.isArray(content)) {
    return 'content is array, expected object with config/header/elements';
  }

  const obj = content as Record<string, unknown>;
  const missing: string[] = [];

  if (!('config' in obj)) { missing.push('config'); }
  if (!('header' in obj)) { missing.push('header'); }
  if (!('elements' in obj)) { missing.push('elements'); }

  if (missing.length > 0) {
    return `missing required fields: ${missing.join(', ')}`;
  }

  if (typeof obj.header !== 'object' || obj.header === null) {
    return 'header must be an object';
  }
  if (!('title' in (obj.header as Record<string, unknown>))) {
    return 'header.title is missing';
  }

  if (!Array.isArray(obj.elements)) {
    return 'elements must be an array';
  }

  return 'unknown validation error';
}
