/**
 * Configuration type definitions for Disclaude.
 *
 * This module defines the TypeScript interfaces for the configuration system,
 * which can be loaded from disclaude.config.yaml or environment variables.
 */

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
 */
export interface AgentConfig {
  /** Model identifier */
  model?: string;
  /** API provider preference (anthropic, glm) */
  provider?: 'anthropic' | 'glm';
  /** Permission mode for SDK */
  permissionMode?: 'default' | 'bypassPermissions';
  /** Maximum concurrent tasks */
  maxConcurrentTasks?: number;
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
 */
export interface GlmConfig {
  /** API key (overrides GLM_API_KEY env var) */
  apiKey?: string;
  /** Model identifier (overrides GLM_MODEL env var) */
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
}

/**
 * Tools configuration section.
 */
export interface ToolsConfig {
  /** List of enabled tools (empty = all enabled) */
  enabled?: string[];
  /** List of disabled tools */
  disabled?: string[];
  /** MCP server configurations */
  mcpServers?: Record<
    string,
    {
      type: 'stdio' | 'sse';
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    }
  >;
}

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
