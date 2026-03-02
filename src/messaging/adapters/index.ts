/**
 * Channel Adapters - Platform-specific message conversion.
 *
 * @see Issue #480
 */

export { CLIAdapter, createCLIAdapter } from './cli-adapter.js';
export { FeishuAdapter, createFeishuAdapter } from './feishu-adapter.js';
export { RESTAdapter, createRESTAdapter, getRESTAdapter, setRESTAdapter } from './rest-adapter.js';
