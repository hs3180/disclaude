/**
 * Unit tests for ClaudeAcpProvider
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ClaudeAcpProvider } from './acp-provider.js';

describe('ClaudeAcpProvider', () => {
  let provider: ClaudeAcpProvider;

  beforeEach(() => {
    provider = new ClaudeAcpProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('properties', () => {
    it('should have correct name', () => {
      expect(provider.name).toBe('claude-acp');
    });

    it('should have correct version', () => {
      expect(provider.version).toBe('0.1.0');
    });

    it('should have ACP version', () => {
      expect(provider.acpVersion).toBe('2025-04-01');
    });
  });

  describe('getAcpInfo', () => {
    it('should return provider info with capabilities', () => {
      const info = provider.getAcpInfo();

      expect(info.name).toBe('claude-acp');
      expect(info.version).toBe('0.1.0');
      expect(info.acpVersion).toBe('2025-04-01');
      expect(info.capabilities).toBeDefined();
      expect(info.capabilities.listSessions).toBe(true);
      expect(info.capabilities.closeSession).toBe(true);
      expect(info.capabilities.availableModes).toContain('code');
      expect(info.capabilities.availableModes).toContain('ask');
    });
  });

  describe('initialize', () => {
    it('should initialize successfully', async () => {
      const info = await provider.initialize();

      expect(info.name).toBe('claude-acp');
      expect(info.acpVersion).toBe('2025-04-01');
    });

    it('should throw if disposed', async () => {
      provider.dispose();
      await expect(provider.initialize()).rejects.toThrow('disposed');
    });
  });

  describe('validateConfig', () => {
    it('should return boolean', () => {
      const result = provider.validateConfig();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('dispose', () => {
    it('should be idempotent', () => {
      provider.dispose();
      provider.dispose(); // Should not throw
    });

    it('should throw on operations after dispose', async () => {
      provider.dispose();
      await expect(provider.createSession()).rejects.toThrow('disposed');
    });
  });

  describe('session management', () => {
    it('should create a session', async () => {
      const session = await provider.createSession({ cwd: '/workspace' });

      expect(session.sessionId).toBeDefined();
      expect(session.state).toBe('idle');
      expect(session.cwd).toBe('/workspace');
    });

    it('should get session info', async () => {
      const created = await provider.createSession({ cwd: '/test' });
      const info = await provider.getSessionInfo(created.sessionId);

      expect(info.sessionId).toBe(created.sessionId);
      expect(info.cwd).toBe('/test');
    });

    it('should list sessions', async () => {
      await provider.createSession({ cwd: '/a' });
      await provider.createSession({ cwd: '/b' });

      const result = await provider.listSessions();
      expect(result.sessions).toHaveLength(2);
    });

    it('should filter sessions by cwd', async () => {
      await provider.createSession({ cwd: '/workspace' });
      await provider.createSession({ cwd: '/other' });
      await provider.createSession({ cwd: '/workspace' });

      const result = await provider.listSessions({ cwd: '/workspace' });
      expect(result.sessions).toHaveLength(2);
    });

    it('should close a session', async () => {
      const session = await provider.createSession();
      await provider.closeSession(session.sessionId);

      await expect(provider.getSessionInfo(session.sessionId)).rejects.toThrow('Session not found');
    });

    it('should throw when getting non-existent session', async () => {
      await expect(provider.getSessionInfo('non-existent')).rejects.toThrow('Session not found');
    });
  });

  describe('session configuration', () => {
    it('should set session mode', async () => {
      const session = await provider.createSession({ mode: 'code' });
      await provider.setSessionMode(session.sessionId, 'ask');

      const info = await provider.getSessionInfo(session.sessionId);
      expect(info.mode).toBe('ask');
    });

    it('should set session model', async () => {
      const session = await provider.createSession();
      await provider.setSessionModel(session.sessionId, 'claude-3-opus');

      // Model is stored for next prompt - just verify no error
      const info = await provider.getSessionInfo(session.sessionId);
      expect(info.sessionId).toBe(session.sessionId);
    });
  });

  describe('prompt', () => {
    it('should throw for non-existent session', async () => {
      await expect(
        provider.prompt('non-existent', { content: 'Hello' })
      ).rejects.toThrow('Session not found');
    });

    it('should throw after dispose', async () => {
      const session = await provider.createSession();
      provider.dispose();

      await expect(
        provider.prompt(session.sessionId, { content: 'Hello' })
      ).rejects.toThrow('disposed');
    });
  });

  describe('cancelPrompt', () => {
    it('should not throw for non-existent session', () => {
      expect(() => provider.cancelPrompt('non-existent')).not.toThrow();
    });
  });

  describe('IAgentSDKProvider compatibility', () => {
    it('should create inline tools', () => {
      // This tests the delegation to ClaudeSDKProvider
      // The actual tool creation requires Zod schema, just verify method exists
      expect(typeof provider.createInlineTool).toBe('function');
    });

    it('should create MCP servers', () => {
      expect(typeof provider.createMcpServer).toBe('function');
    });

    it('should have queryOnce method', () => {
      expect(typeof provider.queryOnce).toBe('function');
    });

    it('should have queryStream method', () => {
      expect(typeof provider.queryStream).toBe('function');
    });
  });
});
