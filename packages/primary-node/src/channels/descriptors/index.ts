/**
 * Channel Descriptors - Built-in channel descriptors for declarative wiring.
 *
 * Each descriptor encapsulates all channel-specific logic:
 * - Channel instantiation (factory)
 * - PilotCallbacks creation
 * - Attachment extraction
 * - Post-registration setup (passive mode, IPC handlers)
 *
 * Usage:
 * ```typescript
 * import { restDescriptor, feishuDescriptor } from './channels/descriptors/index.js';
 * await lifecycleManager.createAndWire(restDescriptor, config);
 * ```
 *
 * Part of Issue #1594: Unify fragmented channel management architecture.
 *
 * @module @disclaude/primary-node/channels/descriptors
 */

export { restDescriptor } from './rest-descriptor.js';
export { feishuDescriptor } from './feishu-descriptor.js';
