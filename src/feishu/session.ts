/**
 * Session storage for Feishu/Lark bot (in-memory Map).
 */

const sessions = new Map<string, string>();

/**
 * Session manager for Feishu/Lark bot.
 * Provides simple in-memory storage for session IDs per chat.
 */
export const sessionManager = {
  /**
   * Get session_id for a chat.
   */
  get(chatId: string): string | null {
    return sessions.get(chatId) ?? null;
  },

  /**
   * Set session_id for a chat.
   */
  set(chatId: string, sessionId: string): void {
    sessions.set(chatId, sessionId);
  },

  /**
   * Clear session for a chat.
   */
  delete(chatId: string): void {
    sessions.delete(chatId);
  },

  // Legacy method names for compatibility
  getSessionId(chatId: string): string | null {
    return this.get(chatId);
  },

  setSessionId(chatId: string, sessionId: string): void {
    this.set(chatId, sessionId);
  },

  clearSession(chatId: string): void {
    this.delete(chatId);
  },
};

/**
 * SessionManager class for backward compatibility.
 * @deprecated Use sessionManager object directly.
 */
export class SessionManager {
  getSessionId(chatId: string): string | null {
    return sessionManager.getSessionId(chatId);
  }

  setSessionId(chatId: string, sessionId: string): void {
    sessionManager.setSessionId(chatId, sessionId);
  }

  clearSession(chatId: string): void {
    sessionManager.clearSession(chatId);
  }
}
