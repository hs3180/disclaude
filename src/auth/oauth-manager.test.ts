/**
 * Tests for auth/oauth-manager.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { OAuthManager } from './oauth-manager.js';
import { TokenStore } from './token-store.js';
import type { OAuthProviderConfig, OAuthToken } from './types.js';

// Mock fetch for token exchange
const originalFetch = global.fetch;

describe('OAuthManager', () => {
  let tempDir: string;
  let tokenStore: TokenStore;
  let manager: OAuthManager;

  const mockProvider: OAuthProviderConfig = {
    name: 'test-provider',
    authUrl: 'https://example.com/oauth/authorize',
    tokenUrl: 'https://example.com/oauth/token',
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    scopes: ['read', 'write'],
    callbackUrl: 'http://localhost:3000/auth/callback',
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-manager-test-'));
    const storagePath = path.join(tempDir, 'tokens.json');
    tokenStore = new TokenStore(storagePath);
    manager = new OAuthManager(tokenStore);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    global.fetch = originalFetch;
    manager.stopCallbackServer();
  });

  describe('generateAuthUrl', () => {
    it('should generate a valid authorization URL', () => {
      const result = manager.generateAuthUrl(mockProvider, 'chat-1');

      expect(result.url).toContain('https://example.com/oauth/authorize');
      expect(result.url).toContain('client_id=test-client-id');
      expect(result.url).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fcallback');
      expect(result.url).toContain('scope=read+write');
      expect(result.url).toContain('response_type=code');
      expect(result.url).toContain('code_challenge_method=S256');
      expect(result.state).toBeDefined();
    });

    it('should generate different states for different calls', () => {
      const result1 = manager.generateAuthUrl(mockProvider, 'chat-1');
      const result2 = manager.generateAuthUrl(mockProvider, 'chat-1');

      expect(result1.state).not.toBe(result2.state);
    });

    it('should include PKCE code challenge', () => {
      const result = manager.generateAuthUrl(mockProvider, 'chat-1');

      expect(result.url).toContain('code_challenge=');
    });
  });

  describe('handleCallback', () => {
    it('should return error for invalid state', async () => {
      const result = await manager.handleCallback('test-code', 'invalid-state');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid or expired');
    });

    it('should exchange code for token and store it', async () => {
      // First generate an auth URL to create a state
      const { state } = manager.generateAuthUrl(mockProvider, 'chat-1');

      // Mock fetch for token exchange
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => ({
          access_token: 'test-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'read write',
        }),
      });

      const result = await manager.handleCallback('test-code', state);

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('chat-1');
      expect(result.provider).toBe('test-provider');

      // Verify token was stored
      const storedToken = await tokenStore.getToken('chat-1', 'test-provider');
      expect(storedToken).not.toBeNull();
      expect(storedToken!.accessToken).toBe('test-access-token');
    });

    it('should handle token exchange failure', async () => {
      const { state } = manager.generateAuthUrl(mockProvider, 'chat-1');

      // Mock fetch failure
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => 'Invalid grant',
      });

      const result = await manager.handleCallback('test-code', state);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Token exchange failed');
    });
  });

  describe('checkToken', () => {
    it('should return false when no token exists', async () => {
      const result = await manager.checkToken('chat-1', 'github');

      expect(result.hasToken).toBe(false);
    });

    it('should return true when valid token exists', async () => {
      const token: OAuthToken = {
        accessToken: 'test-token',
        tokenType: 'Bearer',
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000, // 1 hour from now
      };

      await tokenStore.setToken('chat-1', 'github', token);

      const result = await manager.checkToken('chat-1', 'github');

      expect(result.hasToken).toBe(true);
      expect(result.isExpired).toBe(false);
    });

    it('should return expired when token is expired', async () => {
      const token: OAuthToken = {
        accessToken: 'test-token',
        tokenType: 'Bearer',
        createdAt: Date.now() - 7200000, // 2 hours ago
        expiresAt: Date.now() - 3600000, // Expired 1 hour ago
      };

      await tokenStore.setToken('chat-1', 'github', token);

      const result = await manager.checkToken('chat-1', 'github');

      expect(result.hasToken).toBe(true);
      expect(result.isExpired).toBe(true);
    });
  });

  describe('makeAuthenticatedRequest', () => {
    it('should return 401 when no token exists', async () => {
      const result = await manager.makeAuthenticatedRequest('chat-1', 'github', {
        method: 'GET',
        url: 'https://api.github.com/user',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe(401);
    });

    it('should return 401 when token is expired', async () => {
      const token: OAuthToken = {
        accessToken: 'expired-token',
        tokenType: 'Bearer',
        createdAt: Date.now() - 7200000,
        expiresAt: Date.now() - 3600000,
      };

      await tokenStore.setToken('chat-1', 'github', token);

      const result = await manager.makeAuthenticatedRequest('chat-1', 'github', {
        method: 'GET',
        url: 'https://api.github.com/user',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe(401);
    });

    it('should make authenticated request', async () => {
      const token: OAuthToken = {
        accessToken: 'valid-token',
        tokenType: 'Bearer',
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      };

      await tokenStore.setToken('chat-1', 'github', token);

      // Mock fetch
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => ({ login: 'testuser' }),
      });

      const result = await manager.makeAuthenticatedRequest('chat-1', 'github', {
        method: 'GET',
        url: 'https://api.github.com/user',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe(200);
      expect(result.data).toEqual({ login: 'testuser' });

      // Verify Authorization header was set
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.github.com/user',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer valid-token',
          }),
        })
      );
    });

    it('should handle API error', async () => {
      const token: OAuthToken = {
        accessToken: 'valid-token',
        tokenType: 'Bearer',
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      };

      await tokenStore.setToken('chat-1', 'github', token);

      // Mock fetch with error
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => 'Not Found',
      });

      const result = await manager.makeAuthenticatedRequest('chat-1', 'github', {
        method: 'GET',
        url: 'https://api.github.com/nonexistent',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe(404);
    });
  });

  describe('revokeToken', () => {
    it('should delete existing token', async () => {
      const token: OAuthToken = {
        accessToken: 'test-token',
        tokenType: 'Bearer',
        createdAt: Date.now(),
      };

      await tokenStore.setToken('chat-1', 'github', token);

      const result = await manager.revokeToken('chat-1', 'github');

      expect(result).toBe(true);
      expect(await tokenStore.getToken('chat-1', 'github')).toBeNull();
    });

    it('should return false for non-existent token', async () => {
      const result = await manager.revokeToken('chat-1', 'github');
      expect(result).toBe(false);
    });
  });

  describe('listAuthorizations', () => {
    it('should list authorized providers', async () => {
      const token: OAuthToken = {
        accessToken: 'test-token',
        tokenType: 'Bearer',
        createdAt: Date.now(),
      };

      await tokenStore.setToken('chat-1', 'github', token);
      await tokenStore.setToken('chat-1', 'gitlab', token);
      await tokenStore.setToken('chat-2', 'notion', token);

      const providers = await manager.listAuthorizations('chat-1');

      expect(providers).toHaveLength(2);
      expect(providers).toContain('github');
      expect(providers).toContain('gitlab');
    });
  });
});
