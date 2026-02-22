/**
 * Transport layer module.
 *
 * Provides the abstraction for communication between Communication Node
 * and Execution Node.
 *
 * Usage:
 * ```typescript
 * import { LocalTransport, type ITransport, type TaskRequest } from './transport/index.js';
 *
 * // Create transport
 * const transport = new LocalTransport();
 *
 * // Use transport
 * await transport.start();
 * const response = await transport.sendTask(request);
 * await transport.stop();
 * ```
 */

export * from './types.js';
export { LocalTransport } from './local-transport.js';
