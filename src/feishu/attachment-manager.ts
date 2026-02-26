/**
 * Attachment manager re-export.
 *
 * @deprecated This file is deprecated and will be removed in a future version.
 *
 * Migration guide:
 * - For AttachmentManager class: Import from `../core/index.js` or `../core/attachment-manager.js`
 * - For FileAttachment type: Import from `../channels/adapters/types.js` or `../file-transfer/index.js`
 *
 * This file is kept for backward compatibility during the file transfer system refactoring.
 * @see Issue #194 - Refactor: 统一文件传输系统架构
 */

export {
  AttachmentManager,
  attachmentManager,
} from '../core/attachment-manager.js';

// Re-export FileAttachment type from adapters for backward compatibility
export type { FileAttachment } from '../channels/adapters/types.js';
