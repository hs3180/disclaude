// Content block type from Anthropic API
export interface ContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: string | unknown[];
  [key: string]: unknown;
}

// Agent message interface (wraps SDK message)
export interface AgentMessage {
  content: string | ContentBlock[];
  role?: 'user' | 'assistant';
  stop_reason?: string;
  stop_sequence?: string | null;
}

// Agent options (compatible with Agent SDK)
export interface AgentOptions {
  apiKey: string;
  model: string;
  apiBaseUrl?: string;
  workspace: string;
  // Agent SDK specific options
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  bypassPermissions?: boolean;
}

// Session info for resuming conversations
export interface SessionInfo {
  sessionId?: string;
  resume?: string;
}
