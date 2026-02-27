/**
 * Outbound file transfer components.
 *
 * Handles files going from the system to users.
 */

// Feishu-specific file uploader
export {
  uploadFile,
  sendFileMessage,
  uploadAndSendFile,
  detectFileType,
  type FileType,
  type UploadResult,
} from './feishu-uploader.js';
