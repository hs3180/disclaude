/**
 * Node-to-node file transfer components.
 *
 * Handles file transfer between Communication Node and Execution Node
 * in distributed deployment mode.
 */

// File client for Execution Node
export { FileClient, type FileClientConfig } from './file-client.js';

// File storage for Communication Node
export { FileStorageService, type FileStorageConfig } from './file-storage.js';

// HTTP API handler for file transfer
export {
  createFileTransferAPIHandler,
  type FileTransferAPIConfig,
  type FileTransferAPIHandler,
} from './file-api.js';
