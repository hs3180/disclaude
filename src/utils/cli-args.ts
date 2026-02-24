/**
 * CLI argument parsing utilities.
 *
 * Unified argument parsing for all disclaude modes.
 */

import { Config } from '../config/index.js';
import type { RunMode } from '../config/types.js';

/**
 * Global CLI arguments interface.
 */
export interface GlobalArgs {
  /** Run mode (comm or exec) */
  mode: RunMode | null;
  /** Whether running in prompt/CLI mode */
  promptMode: boolean;
  /** Arguments for prompt mode */
  promptArgs: string[];
  /** Port for communication node (default: 3001) */
  port: number;
  /** Host for communication node */
  host: string;
  /** Communication Node WebSocket URL for exec mode */
  commUrl: string;
  /** Feishu chat ID for output */
  feishuChatId?: string;
  /** Authentication token */
  authToken?: string;
  /** REST channel port */
  restPort?: number;
  /** Enable REST channel */
  enableRestChannel?: boolean;
}

/**
 * Communication Node configuration.
 */
export interface CommNodeConfig {
  /** Port for WebSocket server */
  port: number;
  /** Host for WebSocket server */
  host: string;
  /** Authentication token */
  authToken?: string;
  /** REST channel port */
  restPort?: number;
  /** Enable REST channel */
  enableRestChannel?: boolean;
  /** REST channel auth token */
  restAuthToken?: string;
}

/**
 * Execution Node configuration.
 */
export interface ExecNodeConfig {
  /** Communication Node WebSocket URL */
  commUrl: string;
  /** Authentication token */
  authToken?: string;
}

/**
 * CLI mode configuration.
 */
export interface CliModeConfig {
  prompt: string;
  feishuChatId?: string;
  port: number;
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
 * Parse an integer argument value.
 */
function parseIntArg(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parse global CLI arguments.
 *
 * This is the main entry point for argument parsing.
 * All modes should use this function to get consistent argument handling.
 */
export function parseGlobalArgs(args: string[] = process.argv.slice(2)): GlobalArgs {
  const transportConfig = Config.getTransportConfig();
  const channelsConfig = Config.getChannelsConfig();

  // Default values
  const defaultPort = parseInt(process.env.PORT || '3001', 10);
  const defaultHost = process.env.HOST || '0.0.0.0';
  const defaultCommUrl = process.env.COMM_URL || 'ws://localhost:3001';
  const defaultAuthToken = transportConfig.http?.authToken || process.env.AUTH_TOKEN;
  const defaultRestPort = channelsConfig?.rest?.port || 3000;
  const defaultEnableRest = channelsConfig?.rest?.enabled ?? true;

  // Parse prompt mode
  const promptIndex = args.indexOf('--prompt');
  const promptMode = promptIndex !== -1;

  // Parse mode
  let mode: RunMode | null = null;
  if (args[0] === 'start') {
    const modeValue = parseArgValue(args, '--mode');
    if (modeValue && ['comm', 'exec'].includes(modeValue)) {
      mode = modeValue as RunMode;
    }
  }

  // Parse other arguments
  const port = parseIntArg(parseArgValue(args, '--port'), defaultPort);
  const host = parseArgValue(args, '--host') || defaultHost;
  const commUrl = parseArgValue(args, '--comm-url') || defaultCommUrl;
  const feishuChatId = parseArgValue(args, '--feishu-chat-id');
  const authToken = parseArgValue(args, '--auth-token') || defaultAuthToken;
  const restPort = parseIntArg(parseArgValue(args, '--rest-port'), defaultRestPort);
  const enableRestChannel = args.includes('--no-rest') ? false : defaultEnableRest;

  // Build prompt args (all args for prompt mode)
  const promptArgs = promptMode ? args : [];

  return {
    mode,
    promptMode,
    promptArgs,
    port,
    host,
    commUrl,
    feishuChatId,
    authToken,
    restPort,
    enableRestChannel,
  };
}

/**
 * Get Communication Node configuration from global args.
 */
export function getCommNodeConfig(globalArgs: GlobalArgs): CommNodeConfig {
  const channelsConfig = Config.getChannelsConfig();

  return {
    port: globalArgs.port,
    host: globalArgs.host,
    authToken: globalArgs.authToken,
    restPort: globalArgs.restPort || channelsConfig?.rest?.port || 3000,
    enableRestChannel: globalArgs.enableRestChannel ?? channelsConfig?.rest?.enabled ?? true,
    restAuthToken: channelsConfig?.rest?.authToken,
  };
}

/**
 * Get Execution Node configuration from global args.
 */
export function getExecNodeConfig(globalArgs: GlobalArgs): ExecNodeConfig {
  return {
    commUrl: globalArgs.commUrl,
    authToken: globalArgs.authToken,
  };
}

/**
 * Get CLI mode configuration from global args.
 */
export function getCliModeConfig(globalArgs: GlobalArgs): CliModeConfig | null {
  if (!globalArgs.promptMode) return null;

  const promptIndex = globalArgs.promptArgs.indexOf('--prompt');
  const prompt = promptIndex !== -1 && globalArgs.promptArgs[promptIndex + 1]
    ? globalArgs.promptArgs[promptIndex + 1]
    : globalArgs.promptArgs.join(' ');

  if (!prompt || prompt.trim() === '' || prompt === '--prompt') {
    return null;
  }

  return {
    prompt,
    feishuChatId: globalArgs.feishuChatId,
    port: globalArgs.port,
  };
}
