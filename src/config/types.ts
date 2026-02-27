/**
 * Configuration type definitions for Disclaude.
 *
 * This module defines the TypeScript interfaces for the configuration system,
 * which can be loaded from disclaude.config.yaml or environment variables.
 *
 * Channel configurations extend from the base channel types in channels/types.ts.
 */

// Re-export channel config types from channels module for consistency
export type { ChannelConfig } from '../channels/types.js';

/**
 * Base configuration for all channels in config file.
 * Extends ChannelConfig with config-specific options.
 */
export interface ConfigChannelConfig {
  /** Enable/disable channel */
  enabled?: boolean;
}

/**
 * Workspace configuration section.
 */
export interface WorkspaceConfig {
  /** Working directory for file operations */
  dir?: string;
  /** Maximum file size for operations (in bytes) */
  maxFileSize?: number;
}

/**
 * Agent configuration section.
 *
 * Note: model is configured per-provider (glm.model for GLM, agent.model for Anthropic).
 * This avoids confusion about which model takes precedence.
 */
export interface AgentConfig {
  /** API provider preference (anthropic, glm) */
  provider?: 'anthropic' | 'glm';
  /** Permission mode for SDK */
  permissionMode?: 'default' | 'bypassPermissions';
  /** Maximum concurrent tasks */
  maxConcurrentTasks?: number;
  /** Model identifier for Anthropic/Claude (only used when provider is 'anthropic') */
  model?: string;
}

/**
 * Feishu/Lark platform configuration section.
 */
export interface FeishuConfig {
  /** Application ID (overrides FEISHU_APP_ID env var) */
  appId?: string;
  /** Application secret (overrides FEISHU_APP_SECRET env var) */
  appSecret?: string;
  /** CLI chat ID for testing */
  cliChatId?: string;
  /** Message deduplication settings */
  deduplication?: {
    /** Maximum number of message IDs to track */
    maxIds?: number;
    /** Maximum message age in milliseconds */
    maxAgeMs?: number;
  };
}

/**
 * GLM (Zhipu AI) API configuration section.
 *
 * When using GLM provider, both apiKey and model are REQUIRED.
 * Fallback defaults are intentionally removed for strict configuration.
 */
export interface GlmConfig {
  /** API key (overrides GLM_API_KEY env var) */
  apiKey?: string;
  /** Model identifier - REQUIRED when apiKey is set */
  model?: string;
  /** API base URL (overrides GLM_API_BASE_URL env var) */
  apiBaseUrl?: string;
}

/**
 * Logging configuration section.
 */
export interface LoggingConfig {
  /** Log level (trace, debug, info, warn, error, fatal) */
  level?: string;
  /** Log file path */
  file?: string;
  /** Enable pretty printing in console */
  pretty?: boolean;
  /** Enable log rotation */
  rotate?: boolean;
  /** Enable SDK debug logging and capture subprocess stderr */
  sdkDebug?: boolean;
}

/**
 * MCP server configuration (for external MCP servers like Playwright).
 * Matches the format used in .mcp.json files.
 */
export interface McpServerConfig {
  /** Command to spawn the MCP server process */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Environment variables for the server process (optional) */
  env?: Record<string, string>;
}

/**
 * Tools configuration section.
 */
export interface ToolsConfig {
  /** List of enabled tools (empty = all enabled) */
  enabled?: string[];
  /** List of disabled tools */
  disabled?: string[];
  /** MCP server configurations (format matches .mcp.json) */
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * HTTP transport configuration.
 */
export interface HttpTransportConfig {
  /** Execution Node server configuration */
  execution?: {
    /** Server host */
    host?: string;
    /** Server port */
    port?: number;
  };
  /** Communication Node callback configuration */
  communication?: {
    /** Callback server host */
    callbackHost?: string;
    /** Callback server port */
    callbackPort?: number;
    /** Execution Node URL */
    executionUrl?: string;
  };
  /** Authentication token for securing requests */
  authToken?: string;
}

/**
 * Transport configuration section.
 */
export interface TransportConfig {
  /** Transport mode: local (single process) or http (distributed) */
  type?: 'local' | 'http';
  /** HTTP transport configuration (only used when type is 'http') */
  http?: HttpTransportConfig;
}

/**
 * REST channel configuration for config file.
 * Combines ConfigChannelConfig with channel-specific options.
 */
export interface RestChannelConfig extends ConfigChannelConfig {
  /** Server port for REST API */
  port?: number;
  /** Server host */
  host?: string;
  /** API prefix for all endpoints */
  apiPrefix?: string;
  /** Optional authentication token */
  authToken?: string;
  /** Enable CORS */
  enableCors?: boolean;
}

/**
 * Feishu channel configuration for config file.
 * Combines ConfigChannelConfig with channel-specific options.
 */
export interface FeishuChannelConfig extends ConfigChannelConfig {
  // Feishu-specific config options can be added here
  // Currently only 'enabled' from ConfigChannelConfig
}

/**
 * Channels configuration section.
 */
export interface ChannelsConfig {
  /** REST API channel configuration */
  rest?: RestChannelConfig;
  /** Feishu channel configuration */
  feishu?: FeishuChannelConfig;
}

/**
 * Messaging routing configuration section.
 *
 * Controls how messages are routed between admin and user chats.
 * @see Issue #266
 */
export interface MessagingConfig {
  /** Admin chat configuration */
  admin?: {
    /** Admin chat ID (receives all messages including progress/debug) */
    chatId?: string;
    /** Enable/disable admin chat routing */
    enabled?: boolean;
  };
  /** Message routing configuration */
  routing?: {
    /** Message levels visible to users (debug, progress, info, notice, important, error, result) */
    userLevels?: string[];
    /** Task lifecycle message visibility */
    taskLifecycle?: {
      /** Show task start message */
      showStart?: boolean;
      /** Show progress messages */
      showProgress?: boolean;
      /** Show task complete message */
      showComplete?: boolean;
    };
    /** Error handling options */
    errors?: {
      /** Show stack traces to users */
      showStack?: boolean;
      /** Who can see detailed errors: 'admin' | 'all' */
      showDetails?: 'admin' | 'all';
    };
  };
}

/**
 * Run mode for the application.
 * - comm: Communication Node (Feishu WebSocket handler)
 * - exec: Execution Node (Pilot/Agent handler)
 */
export type RunMode = 'comm' | 'exec';

/**
 * Main configuration interface.
 *
 * This represents the structure of disclaude.config.yaml.
 * All fields are optional - environment variables take precedence.
 */
export interface DisclaudeConfig {
  /** Workspace settings */
  workspace?: WorkspaceConfig;
  /** Agent/AI model settings */
  agent?: AgentConfig;
  /** Feishu platform settings */
  feishu?: FeishuConfig;
  /** GLM API settings */
  glm?: GlmConfig;
  /** Logging settings */
  logging?: LoggingConfig;
  /** Tool configuration */
  tools?: ToolsConfig;
  /** Transport configuration */
  transport?: TransportConfig;
  /** Channels configuration */
  channels?: ChannelsConfig;
  /** Message routing configuration */
  messaging?: MessagingConfig;
  /** Global environment variables applied to all agent processes */
  env?: Record<string, string>;
}

/**
 * Configuration file metadata.
 */
export interface ConfigFileInfo {
  /** Path to the config file */
  path: string;
  /** Whether the file exists */
  exists: boolean;
}

/**
 * Loaded configuration with metadata.
 */
export interface LoadedConfig extends DisclaudeConfig {
  /** Source file path */
  _source?: string;
  /** Whether config was loaded from file */
  _fromFile: boolean;
}

/**
 * Configuration validation error.
 */
export interface ConfigValidationError {
  /** Field path that failed validation (e.g., 'glm.model') */
  field: string;
  /** Human-readable error message */
  message: string;
}
