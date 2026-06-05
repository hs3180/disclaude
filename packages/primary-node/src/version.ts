/**
 * Single source of truth for the Primary Node version string.
 *
 * Extracted into its own file to avoid circular/heavy imports
 * (e.g., index.ts barrel re-exports many modules that would pull
 * in unwanted dependencies at test time).
 */

export const PRIMARY_NODE_VERSION = '0.0.1';
