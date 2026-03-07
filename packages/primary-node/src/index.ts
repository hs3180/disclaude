/**
 * @disclaude/primary-node
 *
 * Primary Node process for disclaude - handles channels, platforms, and coordination.
 *
 * This package contains:
 * - Communication channels (Feishu, REST, Ruliu)
 * - PrimaryNode implementation
 * - Platform adapters
 * - IPC server
 * - WebSocket server
 */

// IPC module
export * from './ipc/index.js';

// Channels
export * from './channels/index.js';

// Platforms
export * from './platforms/index.js';

// Nodes
export { PrimaryNode } from './nodes/primary-node.js';
export { WebSocketServerService } from './nodes/websocket-server-service.js';
export { ExecNodeRegistry } from './nodes/exec-node-registry.js';
export type { NodeCapabilities, PrimaryNodeConfig } from './nodes/types.js';
