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
 */

export * from './file-client.js';
