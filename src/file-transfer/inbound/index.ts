/**
 * Inbound file transfer components.
 *
 * Handles files coming from users to the system.
 */

// Feishu-specific file downloader
export { downloadFile, extractFileExtension } from './feishu-downloader.js';

// Platform-agnostic attachment manager
export { AttachmentManager, attachmentManager } from './attachment-manager.js';
