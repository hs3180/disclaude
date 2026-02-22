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
  /** Port for communication node */
  port: number;
  /** Host for communication node */
  host: string;
  /** Communication URL for execution node */
  communicationUrl: string;
  /** Feishu chat ID for output */
  feishuChatId?: string;
  /** Authentication token */
  authToken?: string;
}

/**
 * Communication Node configuration.
 */
export interface CommNodeConfig {
  port: number;
  host: string;
  callbackPort?: number;
  authToken?: string;
}

/**
 * Execution Node configuration.
 */
export interface ExecNodeConfig {
  communicationUrl: string;
  port?: number;
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

  // Default values from config
  const defaultPort = transportConfig.http?.execution?.port ||
                      parseInt(process.env.PORT || '3001', 10);
  const defaultHost = transportConfig.http?.communication?.callbackHost ||
                      process.env.HOST || '0.0.0.0';
  const defaultCommUrl = transportConfig.http?.communication?.executionUrl ||
                         process.env.COMMUNICATION_URL ||
                         'http://localhost:3001';
  const defaultAuthToken = transportConfig.http?.authToken || process.env.AUTH_TOKEN;

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
  const communicationUrl = parseArgValue(args, '--communication-url') || defaultCommUrl;
  const feishuChatId = parseArgValue(args, '--feishu-chat-id');
  const authToken = parseArgValue(args, '--auth-token') || defaultAuthToken;

  // Build prompt args (all args for prompt mode)
  const promptArgs = promptMode ? args : [];

  return {
    mode,
    promptMode,
    promptArgs,
    port,
    host,
    communicationUrl,
    feishuChatId,
    authToken,
  };
}

/**
 * Get Communication Node configuration from global args.
 */
export function getCommNodeConfig(globalArgs: GlobalArgs): CommNodeConfig {
  return {
    port: globalArgs.port,
    host: globalArgs.host,
    callbackPort: globalArgs.port + 1,
    authToken: globalArgs.authToken,
  };
}

/**
 * Get Execution Node configuration from global args.
 */
export function getExecNodeConfig(globalArgs: GlobalArgs): ExecNodeConfig {
  return {
    communicationUrl: globalArgs.communicationUrl,
    port: globalArgs.port,
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
