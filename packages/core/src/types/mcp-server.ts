/**
 * MCP Server type definitions.
 *
 * This module contains types for the MCP (Model Context Protocol) Server,
 * which provides tools for agent communication with users.
 *
 * @see Issue #1042 - Separate MCP Server code to @disclaude/mcp-server
 */

/**
 * Result type for send_message tool.
 */
export interface SendMessageResult {
  success: boolean;
  message: string;
  error?: string;
}

/**
 * Result type for send_file tool.
 */
export interface SendFileResult {
  success: boolean;
  message: string;
  fileName?: string;
  fileSize?: number;
  sizeMB?: string;
  error?: string;
  platformCode?: string | number;
  platformMsg?: string;
  platformLogId?: string;
  troubleshooterUrl?: string;
}

/**
 * Message sent callback type.
 * Called when a message is successfully sent to track user communication.
 */
export type MessageSentCallback = (chatId: string) => void;

/**
 * Map of action values to prompt templates.
 * Keys are action values from button/menu components.
 * Values are prompt templates that can include placeholders:
 * - {{actionText}} - The display text of the clicked button/option
 * - {{actionValue}} - The value of the action
 * - {{actionType}} - The type of action (button, select_static, etc.)
 * - {{form.fieldName}} - Form field values (for form submissions)
 */
export type ActionPromptMap = Record<string, string>;

/**
 * Context for an interactive message.
 */
export interface InteractiveMessageContext {
  messageId: string;
  chatId: string;
  actionPrompts: ActionPromptMap;
  createdAt: number;
}

/**
 * Result type for send_interactive_message tool.
 */
export interface SendInteractiveResult {
  success: boolean;
  message: string;
  messageId?: string;
  error?: string;
}

/**
 * Option for ask_user tool.
 */
export interface AskUserOption {
  /** Display text for the option (shown on button) */
  text: string;
  /** Value returned when this option is selected (defaults to option_N if not provided) */
  value?: string;
  /** Visual style of the button */
  style?: 'primary' | 'default' | 'danger';
  /** Action description for the agent to execute when this option is selected */
  action?: string;
}

/**
 * Result type for ask_user tool.
 */
export interface AskUserResult {
  success: boolean;
  message: string;
  messageId?: string;
  error?: string;
}

/**
 * Options for creating a study guide.
 */
export interface StudyGuideOptions {
  /** Type of content to generate */
  type: 'summary' | 'qa' | 'flashcards' | 'quiz' | 'mindmap' | 'full';
  /** Source content or topic */
  content: string;
  /** Target audience level */
  level?: 'beginner' | 'intermediate' | 'advanced';
  /** Language for the output */
  language?: string;
  /** Number of items to generate (for qa, flashcards, quiz) */
  count?: number;
}

/**
 * Result type for study guide generation.
 */
export interface StudyGuideResult {
  success: boolean;
  message: string;
  content?: string;
  error?: string;
}

/**
 * MCP Tool definition interface.
 * Represents a tool that can be called by the agent.
 */
export interface McpToolDefinition {
  /** Tool name */
  name: string;
  /** Tool description */
  description: string;
  /** Input schema (JSON Schema) */
  inputSchema: Record<string, unknown>;
}

/**
 * MCP Tool execution context.
 * Provides context information for tool execution.
 */
export interface McpToolContext {
  /** Current chat ID */
  chatId?: string;
  /** Current message ID */
  messageId?: string;
  /** User ID */
  userId?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Node type identifier.
 */
export type NodeType = 'primary' | 'worker' | 'mcp-server';

/**
 * Base configuration for all node types.
 */
export interface BaseNodeConfig {
  /** Node type identifier */
  nodeType: NodeType;
  /** Node name for logging */
  nodeName: string;
  /** Enable debug mode */
  debug?: boolean;
}

/**
 * MCP Server configuration.
 */
export interface McpServerConfig extends BaseNodeConfig {
  nodeType: 'mcp-server';
  /** IPC socket path for communication with Primary Node */
  ipcSocketPath?: string;
  /** Enable stdio transport */
  stdio?: boolean;
}

/**
 * Node capability flags.
 */
export interface NodeCapabilities {
  /** Can communicate with external platforms */
  communication: boolean;
  /** Can execute agent tasks */
  execution: boolean;
}

/**
 * Get capabilities for a node type.
 */
export function getNodeCapabilities(nodeType: NodeType): NodeCapabilities {
  switch (nodeType) {
    case 'primary':
      return { communication: true, execution: false };
    case 'worker':
      return { communication: false, execution: true };
    case 'mcp-server':
      return { communication: true, execution: false };
  }
}
