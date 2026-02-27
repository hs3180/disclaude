/**
 * Transport layer - File Client for file transfer.
 *
 * Architecture:
 * ```
 * Communication Node                    Execution Node
 *     │                                     │
 *     │  HTTP Server (:3001)                │  HTTP Server (:3002)
 *     │  - POST /callback                   │  - POST /execute
 *     │  - GET /health                      │  - GET /health
 *     │  - /api/files/* (file transfer)     │
 *     │                                     │
 *     │  ──── POST /execute ────────────►   │
 *     │  { chatId, prompt, ... }            │
 *     │                                     │
 *     │  ◄──── POST /callback ───────────   │
 *     │  { chatId, type, text, ... }        │
 * ```
 *
 * @deprecated - FileClient has been moved to file-transfer/node-transfer/
 */

// Re-export from new location for backward compatibility
export * from '../file-transfer/node-transfer/index.js';
