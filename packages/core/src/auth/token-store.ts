/**
 * Token storage for OAuth tokens.
 *
 * Stores tokens encrypted on disk, keyed by chatId + provider.
 * File-based storage for simplicity (no database required).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { Config } from '../config/index.js';
import { encrypt, decrypt } from './crypto.js';
import type { OAuthToken } from './types.js';

const logger = createLogger('TokenStore');

/**
 * Token storage file structure.
 */
interface TokenStorageFile {
  /** Version for migration support */
  version: 1;
  /** Tokens keyed by "chatId:provider" */
  tokens: Record<string, string>; // encrypted OAuthToken JSON
}

/**
 * Token store for managing OAuth tokens.
 *
 * Tokens are stored encrypted in a JSON file.
 * Key format: `${chatId}:${provider}`
 */
export class TokenStore {
  private readonly storagePath: string;
  private cache: TokenStorageFile | null = null;

  constructor(storagePath?: string) {
    // Default to .auth-tokens.json in workspace directory
    this.storagePath = storagePath || path.join(
      Config.getWorkspaceDir(),
      '.auth-tokens.json'
    );
  }

  /**
   * Get the storage key for a chatId + provider combination.
   */
  private getKey(chatId: string, provider: string): string {
    return `${chatId}:${provider}`;
  }

  /**
   * Load the token storage file.
   */
  private async load(): Promise<TokenStorageFile> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const content = await fs.readFile(this.storagePath, 'utf-8');
      const data = JSON.parse(content) as TokenStorageFile;

      // Validate version
      if (data.version !== 1) {
        throw new Error(`Unsupported token storage version: ${data.version}`);
      }

      this.cache = data;
      return data;
    } catch (error) {
      // File doesn't exist or is invalid - return empty structure
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const empty: TokenStorageFile = { version: 1, tokens: {} };
        this.cache = empty;
        return empty;
      }
      throw error;
    }
  }

  /**
   * Save the token storage file.
   */
  private async save(data: TokenStorageFile): Promise<void> {
    // Ensure directory exists
    const dir = path.dirname(this.storagePath);
    await fs.mkdir(dir, { recursive: true });

    // Write atomically using temp file
    const tempPath = `${this.storagePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tempPath, this.storagePath);

    // Update cache
    this.cache = data;

    logger.debug({ path: this.storagePath }, 'Token storage saved');
  }

  /**
   * Store a token for a chatId + provider.
   *
   * @param chatId - Chat identifier
   * @param provider - Provider name
   * @param token - OAuth token to store
   */
  async setToken(
    chatId: string,
    provider: string,
    token: OAuthToken
  ): Promise<void> {
    const data = await this.load();
    const key = this.getKey(chatId, provider);

    // Encrypt token before storage
    const encrypted = encrypt(JSON.stringify(token));
    data.tokens[key] = encrypted;

    await this.save(data);
    logger.info({ chatId, provider }, 'Token stored');
  }

  /**
   * Get a token for a chatId + provider.
   *
   * @param chatId - Chat identifier
   * @param provider - Provider name
   * @returns OAuth token or null if not found
   */
  async getToken(chatId: string, provider: string): Promise<OAuthToken | null> {
    const data = await this.load();
    const key = this.getKey(chatId, provider);

    const encrypted = data.tokens[key];
    if (!encrypted) {
      return null;
    }

    try {
      const decrypted = decrypt(encrypted);
      return JSON.parse(decrypted) as OAuthToken;
    } catch (error) {
      logger.error({ err: error, chatId, provider }, 'Failed to decrypt token');
      return null;
    }
  }

  /**
   * Check if a token exists for a chatId + provider.
   *
   * @param chatId - Chat identifier
   * @param provider - Provider name
   * @returns true if token exists (may be expired)
   */
  async hasToken(chatId: string, provider: string): Promise<boolean> {
    const data = await this.load();
    const key = this.getKey(chatId, provider);
    return key in data.tokens;
  }

  /**
   * Delete a token for a chatId + provider.
   *
   * @param chatId - Chat identifier
   * @param provider - Provider name
   * @returns true if token was deleted
   */
  async deleteToken(chatId: string, provider: string): Promise<boolean> {
    const data = await this.load();
    const key = this.getKey(chatId, provider);

    if (!(key in data.tokens)) {
      return false;
    }

    delete data.tokens[key];
    await this.save(data);

    logger.info({ chatId, provider }, 'Token deleted');
    return true;
  }

  /**
   * List all providers that have tokens for a chatId.
   *
   * @param chatId - Chat identifier
   * @returns Array of provider names
   */
  async listProviders(chatId: string): Promise<string[]> {
    const data = await this.load();
    const prefix = `${chatId}:`;

    const providers: string[] = [];
    for (const key of Object.keys(data.tokens)) {
      if (key.startsWith(prefix)) {
        providers.push(key.slice(prefix.length));
      }
    }

    return providers;
  }

  /**
   * Get the decrypted access token for API calls.
   *
   * @param chatId - Chat identifier
   * @param provider - Provider name
   * @returns Access token or null if not found
   */
  async getAccessToken(chatId: string, provider: string): Promise<string | null> {
    const token = await this.getToken(chatId, provider);
    if (!token) {
      return null;
    }

    // Check if expired
    if (token.expiresAt && token.expiresAt < Date.now()) {
      logger.info({ chatId, provider }, 'Token is expired');
      return null;
    }

    return token.accessToken;
  }

  /**
   * Clear the in-memory cache.
   */
  clearCache(): void {
    this.cache = null;
  }
}

/**
 * Singleton token store instance.
 */
let tokenStoreInstance: TokenStore | null = null;

/**
 * Get the global token store instance.
 */
export function getTokenStore(): TokenStore {
  if (!tokenStoreInstance) {
    tokenStoreInstance = new TokenStore();
  }
  return tokenStoreInstance;
}
