/**
 * Single source of truth for the disclaude service version string.
 *
 * Extracted into its own file to avoid circular/heavy imports
 * (e.g., index.ts barrel re-exports many modules that would pull
 * in unwanted dependencies at test time).
 */

export const SERVICE_VERSION = '0.0.1';
