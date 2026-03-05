/**
 * Feishu card validation utilities.
 *
 * This module provides validation functions for Feishu interactive card structures.
 * Used to ensure card content meets Feishu API requirements before sending.
 */

/**
 * Check if content is a valid Feishu interactive card structure.
 * Valid cards must have: config, header (with title), and elements array.
 *
 * @param content - Object to validate
 * @returns true if valid Feishu card structure
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
 * Used to provide helpful error messages to LLM for self-correction.
 *
 * @param content - Object to validate
 * @returns Human-readable error message describing what's wrong
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

  // Check header structure
  if (typeof obj.header !== 'object' || obj.header === null) {
    return 'header must be an object';
  }
  if (!('title' in (obj.header as Record<string, unknown>))) {
    return 'header.title is missing';
  }

  // Check elements structure
  if (!Array.isArray(obj.elements)) {
    return 'elements must be an array';
  }

  return 'unknown validation error';
}
