/**
 * Transport layer types.
 *
 * These types define the interfaces for message passing between nodes.
 * The actual transport implementation is now done via direct HTTP calls.
 *
 * Architecture:
 * ```
 * Communication Node                    Execution Node
 *     │                                     │
 *     │  HTTP Server (:3001)                │  HTTP Server (:3002)
 *     │  - POST /callback                   │  - POST /execute
 *     │  - GET /health                      │  - GET /health
 *     │                                     │
 *     │  ──── POST /execute ────────────►   │
 *     │  { chatId, prompt, ... }            │
 *     │                                     │
 *     │  ◄──── POST /callback ───────────   │
 *     │  { chatId, type, text, ... }        │
 * ```
 */

export * from './types.js';
