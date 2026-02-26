/**
 * Attachment manager re-export.
 *
 * @deprecated Import from '../core/index.js' instead.
 * This file is kept for backward compatibility.
 */

export {
  AttachmentManager,
  attachmentManager,
} from '../core/attachment-manager.js';

// Re-export FileAttachment type from adapters for backward compatibility
export type { FileAttachment } from '../channels/adapters/types.js';
