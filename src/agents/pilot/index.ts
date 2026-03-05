/**
 * Pilot Module - Re-exports for backward compatibility.
 *
 * Issue #697: Module structure for Pilot agent.
 */

// Export main class
export { Pilot } from './pilot.js';

// Export types
export type { PilotCallbacks, PilotConfig, MessageData } from './types.js';

// Export message builder utilities (for testing)
export { buildEnhancedContent, buildToolsSection, buildAttachmentsInfo } from './message-builder.js';
