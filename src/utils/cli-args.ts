/**
 * CLI argument parsing utilities.
 *
 * Unified argument parsing for all disclaude modes.
 */

import { Config } from '../config/index.js';

/**
 * Run mode type.
 * Note: 'primary' mode has been moved to @disclaude/primary-node package.
 */
export type RunMode = 'worker';

/**
 * Global CLI arguments interface.
 */
export interface GlobalArgs {
  /** Run mode (worker only, primary mode moved to @disclaude/primary-node) */
  mode: RunMode | null;
  /** Primary Node WebSocket URL for worker mode */
  commUrl: string;
  /** Authentication token */
  authToken?: string;
  /** Node ID for worker mode */
  nodeId?: string;
  /** Node name for worker mode */
  nodeName?: string;
  /** Configuration file path */
  config?: string;
}

/**
 * Parse config path from arguments.
 * This function is used early before Config is loaded.
 *
 * @param args - Command line arguments
 * @returns Config file path or undefined
 */
export function parseConfigPath(args: string[] = process.argv.slice(2)): string | undefined {
  const index = args.indexOf('--config');
  if (index !== -1 && args[index + 1]) {
    return args[index + 1];
  }
  return undefined;
}

/**
 * Worker Node configuration.
 */
export interface WorkerNodeConfig {
  /** Primary Node WebSocket URL */
  commUrl: string;
  /** Authentication token */
  authToken?: string;
  /** Unique identifier for this worker node (auto-generated if not provided) */
  nodeId?: string;
  /** Human-readable name for this worker node */
  nodeName?: string;
}

/**
 * Parse a command line argument value.
 */
function parseArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index !== -1 && args[index + 1]) {
    return args[index + 1];
  }
  return undefined;
}

/**
 * Parse global CLI arguments.
 *
 * This is the main entry point for argument parsing.
 * All modes should use this function to get consistent argument handling.
 */
export function parseGlobalArgs(args: string[] = process.argv.slice(2)): GlobalArgs {
  const transportConfig = Config.getTransportConfig();

  // Default values
  const defaultCommUrl = process.env.COMM_URL || 'ws://localhost:3001';
  const defaultAuthToken = transportConfig.http?.authToken || process.env.AUTH_TOKEN;

  // Parse mode
  let mode: RunMode | null = null;
  if (args[0] === 'start') {
    const modeValue = parseArgValue(args, '--mode');
    if (modeValue === 'worker') {
      mode = modeValue;
    }
  }

  // Parse other arguments
  const commUrl = parseArgValue(args, '--comm-url') || defaultCommUrl;
  const authToken = parseArgValue(args, '--auth-token') || defaultAuthToken;
  const nodeId = parseArgValue(args, '--node-id') || process.env.EXEC_NODE_ID;
  const nodeName = parseArgValue(args, '--node-name') || process.env.EXEC_NODE_NAME;
  const config = parseArgValue(args, '--config');

  return {
    mode,
    commUrl,
    authToken,
    nodeId,
    nodeName,
    config,
  };
}

/**
 * Get Worker Node configuration from global args.
 */
export function getWorkerNodeConfig(globalArgs: GlobalArgs): WorkerNodeConfig {
  return {
    commUrl: globalArgs.commUrl,
    authToken: globalArgs.authToken,
    nodeId: globalArgs.nodeId,
    nodeName: globalArgs.nodeName,
  };
}
