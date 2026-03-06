/**
 * IPC Protocol definitions for cross-process communication.
 *
 * @module ipc/protocol
 */

/**
 * IPC request types
 */
export type IpcRequestType =
  | 'get_action_prompts'
  | 'register_action_prompts'
  | 'unregister_action_prompts'
  | 'generate_interaction_prompt'
  | 'cleanup_expired_contexts'
  | 'ping';

/**
 * Base IPC request
 */
export interface IpcRequest<T extends IpcRequestType = IpcRequestType> {
  type: T;
  id: string;
  payload: IpcRequestPayloads[T];
}

/**
 * Base IPC response
 */
export interface IpcResponse<T extends IpcRequestType = IpcRequestType> {
  id: string;
  success: boolean;
  result?: IpcResponseResults[T];
  error?: string;
}

/**
 * Request payloads by type
 */
export interface IpcRequestPayloads {
  get_action_prompts: { messageId: string };
  register_action_prompts: {
    messageId: string;
    chatId: string;
    actionPrompts: Record<string, string>;
  };
  unregister_action_prompts: { messageId: string };
  generate_interaction_prompt: {
    messageId: string;
    actionValue: string;
    actionText?: string;
    actionType?: string;
    formData?: Record<string, unknown>;
  };
  cleanup_expired_contexts: Record<string, never>;
  ping: Record<string, never>;
}

/**
 * Response results by type
 */
export interface IpcResponseResults {
  get_action_prompts: { prompts: Record<string, string> | null };
  register_action_prompts: { success: boolean };
  unregister_action_prompts: { success: boolean };
  generate_interaction_prompt: { prompt: string | null };
  cleanup_expired_contexts: { cleaned: number };
  ping: { pong: true };
}

/**
 * Default Unix socket path for interactive message IPC
 */
export const DEFAULT_IPC_SOCKET_PATH = '/tmp/disclaude-interactive.ipc';

/**
 * IPC configuration
 */
export interface IpcConfig {
  socketPath: string;
  timeout: number;
}

/**
 * Default IPC configuration
 */
export const DEFAULT_IPC_CONFIG: IpcConfig = {
  socketPath: DEFAULT_IPC_SOCKET_PATH,
  timeout: 5000, // 5 seconds
};
