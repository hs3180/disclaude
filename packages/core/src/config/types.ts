/**
 * Configuration type definitions for Disclaude core.
 *
 * This module defines the TypeScript interfaces for the configuration system,
 * which can be loaded from disclaude.config.yaml or environment variables.
 *
 * Channel-specific configurations (RestChannelConfig, FeishuChannelConfig, etc.)
 * are NOT included here - they are defined in the main project's config/types.ts.
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
  /**
   * Enable Claude Code Agent Teams mode.
   * When enabled, sets CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 for SDK subprocess.
   * This allows the agent to spawn and coordinate multiple teammate sessions.
   * @see https://code.claude.com/docs/en/agent-teams
   */
  enableAgentTeams?: boolean;
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
 * Ruliu reply mode.
 * Controls how the bot responds to messages.
 */
export type RuliuReplyMode =
  | 'ignore'           // Discard messages
  | 'record'           // Only record, no reply
  | 'mention-only'     // Reply only when @mentioned
  | 'mention-and-watch' // @ + watch list + follow-up window (default)
  | 'proactive';       // Proactive participation

/**
 * Ruliu (如流) platform configuration section.
 * Baidu's enterprise instant messaging platform integration.
 * @see Issue #725
 */
export interface RuliuConfig {
  /** Enable/disable Ruliu integration */
  enabled?: boolean;
  /** API host (e.g., https://apiin.im.baidu.com) */
  apiHost?: string;
  /** Verification token from Ruliu bot settings */
  checkToken?: string;
  /** Message encryption key (Base64 encoded, 43 characters) */
  encodingAESKey?: string;
  /** Application key from Ruliu bot settings */
  appKey?: string;
  /** Application secret from Ruliu bot settings */
  appSecret?: string;
  /** Robot name for @mention detection */
  robotName?: string;
  /** Reply mode (default: mention-and-watch) */
  replyMode?: RuliuReplyMode;
  /** Enable follow-up mode */
  followUp?: boolean;
  /** Follow-up window in seconds */
  followUpWindow?: number;
  /** Users to watch for mentions */
  watchMentions?: string[];
  /** Webhook path for receiving messages */
  webhookPath?: string;
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
 * Filter reason types for message filtering.
 * @see Issue #597
 */
export type FilterReason =
  | 'duplicate'
  | 'bot'
  | 'old'
  | 'unsupported'
  | 'empty'
  | 'passive_mode';

/**
 * Debug configuration for filtered message forwarding.
 * @see Issue #597
 */
export interface DebugConfig {
  /** Enable filtered message forwarding */
  enabled?: boolean;
  /** Chat ID to forward filtered messages to */
  filterForwardChatId?: string;
  /** Filter reasons to include in forwarding (empty = all) */
  includeReasons?: FilterReason[];
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
  /** Debug configuration for filtered message forwarding */
  debug?: DebugConfig;
}

/**
 * Session restoration configuration (Issue #1213).
 * Controls how chat history is loaded when agent starts or resets.
 */
export interface SessionRestoreConfig {
  /** Number of days to look back for chat history (default: 7) */
  historyDays?: number;
  /** Maximum characters for restored session context (default: 4000) */
  maxContextLength?: number;
  /** Session timeout configuration (Issue #1313) */
  sessionTimeout?: SessionTimeoutConfig;
}

/**
 * Session timeout configuration (Issue #1313).
 * Controls automatic cleanup of idle sessions to release resources.
 */
export interface SessionTimeoutConfig {
  /** Enable session timeout management (default: false) */
  enabled?: boolean;
  /** Minutes of inactivity before session is closed (default: 30) */
  idleMinutes?: number;
  /** Maximum concurrent sessions allowed (default: 100) */
  maxSessions?: number;
  /** Interval in minutes between timeout checks (default: 5) */
  checkIntervalMinutes?: number;
}

/**
 * SOUL.md personality configuration (Issue #1315).
 * Controls how Agent personality definitions are loaded.
 */
export interface SoulConfig {
  /** Path to the SOUL.md file (supports ~ for home directory) */
  path?: string;
}

/**
 * Run mode for the application.
 * - comm: Communication Node (Feishu WebSocket handler)
 * - exec: Execution Node (Pilot/Agent handler)
 */
export type RunMode = 'comm' | 'exec';

/**
 * Main configuration interface (core).
 *
 * This represents the structure of disclaude.config.yaml WITHOUT channel-specific config.
 * Channel configurations are added in the main project's extended DisclaudeConfig.
 *
 * All fields are optional - environment variables take precedence.
 */
export interface DisclaudeConfig {
  /** Workspace settings */
  workspace?: WorkspaceConfig;
  /** Agent/AI model settings */
  agent?: AgentConfig;
  /** Feishu platform settings */
  feishu?: FeishuConfig;
  /** Ruliu (如流) platform settings */
  ruliu?: RuliuConfig;
  /** GLM API settings */
  glm?: GlmConfig;
  /** Logging settings */
  logging?: LoggingConfig;
  /** Tool configuration */
  tools?: ToolsConfig;
  /** Transport configuration */
  transport?: TransportConfig;
  /** Message routing configuration */
  messaging?: MessagingConfig;
  /** Session restoration configuration (Issue #1213) */
  sessionRestore?: SessionRestoreConfig;
  /** SOUL.md personality configuration (Issue #1315) */
  soul?: SoulConfig;
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

/**
 * Base channel configuration interface.
 * Extended by specific channel implementations in main project.
 */
export interface ConfigChannelConfig {
  /** Enable/disable channel */
  enabled?: boolean;
}

/**
 * Channels configuration section (abstract).
 * Main project extends this with specific channel types.
 */
export interface ChannelsConfig {
  [channelName: string]: ConfigChannelConfig | undefined;
}

/**
 * Extended Disclaude config with channel support.
 */
export interface DisclaudeConfigWithChannels extends DisclaudeConfig {
  /** Channels configuration */
  channels?: ChannelsConfig;
}
