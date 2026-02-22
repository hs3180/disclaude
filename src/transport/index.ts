/**
 * Transport layer module.
 *
 * Provides the abstraction for communication between Communication Node
 * and Execution Node.
 *
 * Usage:
 * ```typescript
 * import { LocalTransport, HttpTransport, type ITransport, type TaskRequest } from './transport/index.js';
 *
 * // Single-process mode
 * const localTransport = new LocalTransport();
 *
 * // Distributed mode
 * const httpTransport = new HttpTransport({ mode: 'execution', port: 3001 });
 *
 * // Use transport
 * await transport.start();
 * const response = await transport.sendTask(request);
 * await transport.stop();
 * ```
 */

export * from './types.js';
export { LocalTransport } from './local-transport.js';
export { HttpTransport, type HttpTransportConfig } from './http-transport.js';
