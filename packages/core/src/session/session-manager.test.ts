/**
 * Tests for Temporary Session Manager
 *
 * @module @disclaude/core/session
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SessionManager, parseDuration, isSessionExpired } from './session-manager.js';
import type {
  SessionConfig,
  SessionState,
  TemporarySession,
} from './types.js';

describe('SessionManager', () => {
  let manager: SessionManager;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'session-test-'));
    manager = new SessionManager({ sessionsDir: tempDir });
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  // ============================================================================
  // parseDuration
  // ============================================================================

  describe('parseDuration', () => {
    it('should parse hours', () => {
      expect(parseDuration('24h')).toBe(24 * 60 * 60 * 1000);
    });

    it('should parse minutes', () => {
      expect(parseDuration('30m')).toBe(30 * 60 * 1000);
    });

    it('should parse days', () => {
      expect(parseDuration('2d')).toBe(2 * 24 * 60 * 60 * 1000);
    });

    it('should parse seconds', () => {
      expect(parseDuration('30s')).toBe(30 * 1000);
    });

    it('should parse compound durations', () => {
      expect(parseDuration('1d12h')).toBe(36 * 60 * 60 * 1000);
      expect(parseDuration('1h30m')).toBe(90 * 60 * 1000);
    });

    it('should return default for empty string', () => {
      expect(parseDuration('')).toBe(24 * 60 * 60 * 1000);
    });

    it('should return default for null/undefined', () => {
      expect(parseDuration(null as unknown as string)).toBe(24 * 60 * 60 * 1000);
      expect(parseDuration(undefined as unknown as string)).toBe(24 * 60 * 60 * 1000);
    });
  });

  // ============================================================================
  // isSessionExpired
  // ============================================================================

  describe('isSessionExpired', () => {
    it('should return true for past expiration', () => {
      const session = {
        state: { expiresAt: '2020-01-01T00:00:00.000Z' },
      } as TemporarySession;
      expect(isSessionExpired(session)).toBe(true);
    });

    it('should return false for future expiration', () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const session = {
        state: { expiresAt: futureDate },
      } as TemporarySession;
      expect(isSessionExpired(session)).toBe(false);
    });

    it('should return false when no expiresAt', () => {
      const session = { state: {} } as TemporarySession;
      expect(isSessionExpired(session)).toBe(false);
    });
  });

  // ============================================================================
  // Create
  // ============================================================================

  describe('create', () => {
    const validConfig: SessionConfig = {
      type: 'blocking',
      purpose: 'pr-review',
      channel: { type: 'group', name: 'PR #123 Review', members: ['ou_xxx'] },
      expiresIn: '24h',
      options: [
        { value: 'merge', text: '✓ Merge' },
        { value: 'close', text: '✗ Close' },
      ],
    };

    it('should create a session with auto-generated ID', async () => {
      const session = await manager.create({ config: validConfig });

      expect(session.id).toBeDefined();
      expect(session.id).toMatch(/^[a-z][a-z0-9-]+-[a-z0-9]+$/);
      expect(session.config).toEqual(validConfig);
      expect(session.state.status).toBe('pending');
      expect(session.state.createdAt).toBeDefined();
      expect(session.state.expiresAt).toBeDefined();
      expect(session.state.response).toBeUndefined();
    });

    it('should create a session with custom ID', async () => {
      const session = await manager.create({
        id: 'pr-123-review',
        config: validConfig,
      });

      expect(session.id).toBe('pr-123-review');
    });

    it('should create session folder with config and state files', async () => {
      const session = await manager.create({ config: validConfig });

      const sessionDir = path.join(tempDir, session.id);
      const configExists = await fsPromises
        .access(path.join(sessionDir, 'session.md'))
        .then(() => true)
        .catch(() => false);
      const stateExists = await fsPromises
        .access(path.join(sessionDir, 'state.yaml'))
        .then(() => true)
        .catch(() => false);

      expect(configExists).toBe(true);
      expect(stateExists).toBe(true);
    });

    it('should set expiration based on expiresIn', async () => {
      const session = await manager.create({
        config: { ...validConfig, expiresIn: '1h' },
      });

      const created = new Date(session.state.createdAt).getTime();
      const expires = new Date(session.state.expiresAt!).getTime();
      const diffMs = expires - created;

      // Allow 1 second tolerance
      expect(diffMs).toBeGreaterThanOrEqual(59 * 60 * 1000);
      expect(diffMs).toBeLessThanOrEqual(61 * 60 * 1000);
    });

    it('should throw for invalid config type', async () => {
      const invalidConfig = {
        ...validConfig,
        type: 'invalid' as SessionConfig['type'],
      };

      await expect(manager.create({ config: invalidConfig })).rejects.toThrow(
        'Invalid session config',
      );
    });

    it('should throw for group type without name', async () => {
      const invalidConfig = {
        ...validConfig,
        channel: { type: 'group' as const, name: undefined },
      };

      await expect(manager.create({ config: invalidConfig })).rejects.toThrow(
        'Channel name is required',
      );
    });

    it('should throw for existing type without chatId', async () => {
      const invalidConfig: SessionConfig = {
        type: 'blocking',
        purpose: 'pr-review',
        channel: { type: 'existing', chatId: '' },
        expiresIn: '24h',
      };

      await expect(manager.create({ config: invalidConfig })).rejects.toThrow(
        'chatId is required',
      );
    });
  });

  // ============================================================================
  // Read
  // ============================================================================

  describe('get', () => {
    it('should return undefined for non-existent session', async () => {
      const session = await manager.get('non-existent');
      expect(session).toBeUndefined();
    });

    it('should read a previously created session', async () => {
      const created = await manager.create({
        id: 'test-session',
        config: {
          type: 'blocking',
          purpose: 'pr-review',
          channel: { type: 'group', name: 'PR #123' },
          expiresIn: '24h',
        },
      });

      const read = await manager.get('test-session');

      expect(read).toBeDefined();
      expect(read!.id).toBe('test-session');
      expect(read!.config.type).toBe('blocking');
      expect(read!.config.purpose).toBe('pr-review');
      expect(read!.state.status).toBe('pending');
      expect(read!.state.createdAt).toBe(created.state.createdAt);
    });

    it('should preserve context data', async () => {
      await manager.create({
        id: 'context-test',
        config: {
          type: 'blocking',
          purpose: 'pr-review',
          channel: { type: 'group', name: 'PR #123' },
          expiresIn: '24h',
          context: { prNumber: 123, repository: 'hs3180/disclaude' },
        },
      });

      const session = await manager.get('context-test');
      expect(session!.config.context).toEqual({
        prNumber: 123,
        repository: 'hs3180/disclaude',
      });
    });
  });

  // ============================================================================
  // List
  // ============================================================================

  describe('list', () => {
    beforeEach(async () => {
      await manager.create({
        id: 'session-pending',
        config: {
          type: 'blocking',
          purpose: 'pr-review',
          channel: { type: 'group', name: 'PR #123' },
          expiresIn: '24h',
        },
      });
      await manager.create({
        id: 'session-offline',
        config: {
          type: 'non-blocking',
          purpose: 'offline-question',
          channel: { type: 'existing', chatId: 'oc_xxx' },
          expiresIn: '1h',
        },
      });
    });

    it('should list all active sessions', async () => {
      const sessions = await manager.list();
      expect(sessions).toHaveLength(2);
    });

    it('should filter by status', async () => {
      // Mark one as sent
      await manager.markAsSent('session-pending', 'oc_new', 'om_new');
      const sessions = await manager.list({ status: 'pending' });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('session-offline');
    });

    it('should filter by purpose', async () => {
      const sessions = await manager.list({ purpose: 'pr-review' });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].purpose).toBe('pr-review');
    });

    it('should respect limit', async () => {
      const sessions = await manager.list({ limit: 1 });
      expect(sessions).toHaveLength(1);
    });

    it('should include expired when requested', async () => {
      // Create an already-expired session manually
      const expiredSessionDir = path.join(tempDir, 'session-expired');
      await fsPromises.mkdir(expiredSessionDir, { recursive: true });

      const configContent = `---\ntype: blocking\npurpose: pr-review\nchannel:\n  type: group\n  name: PR #456\nexpiresIn: 1h\n---\n`;
      await fsPromises.writeFile(
        path.join(expiredSessionDir, 'session.md'),
        configContent,
      );
      const state: SessionState = {
        status: 'sent',
        createdAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-02T00:00:00.000Z',
      };
      const yaml = await import('js-yaml');
      await fsPromises.writeFile(
        path.join(expiredSessionDir, 'state.yaml'),
        yaml.dump(state),
      );

      const withoutExpired = await manager.list();
      expect(withoutExpired.every(s => s.id !== 'session-expired')).toBe(true);

      const withExpired = await manager.list({ includeExpired: true });
      expect(withExpired.some(s => s.id === 'session-expired')).toBe(true);
    });

    it('should auto-expire timed-out sent sessions', async () => {
      // Create an expired sent session
      const expiredDir = path.join(tempDir, 'session-timedout');
      await fsPromises.mkdir(expiredDir, { recursive: true });

      const configContent = `---\ntype: blocking\npurpose: pr-review\nchannel:\n  type: group\n  name: PR #789\nexpiresIn: 1h\n---\n`;
      await fsPromises.writeFile(
        path.join(expiredDir, 'session.md'),
        configContent,
      );
      const state: SessionState = {
        status: 'sent',
        createdAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-02T00:00:00.000Z',
      };
      const yaml = await import('js-yaml');
      await fsPromises.writeFile(
        path.join(expiredDir, 'state.yaml'),
        yaml.dump(state),
      );

      // List should auto-expire the timed-out session
      const sessions = await manager.list({ includeExpired: true });
      const timedOut = sessions.find(s => s.id === 'session-timedout');
      expect(timedOut?.status).toBe('expired');
    });

    it('should return empty array for empty directory', async () => {
      const emptyDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'empty-sessions-'));
      const emptyManager = new SessionManager({ sessionsDir: emptyDir });
      const sessions = await emptyManager.list();
      expect(sessions).toHaveLength(0);
      await fsPromises.rm(emptyDir, { recursive: true, force: true });
    });
  });

  // ============================================================================
  // State Transitions
  // ============================================================================

  describe('markAsSent', () => {
    it('should transition pending → sent', async () => {
      await manager.create({
        id: 'test-send',
        config: {
          type: 'blocking',
          purpose: 'pr-review',
          channel: { type: 'group', name: 'PR #123' },
          expiresIn: '24h',
        },
      });

      const session = await manager.markAsSent('test-send', 'oc_group', 'om_msg');

      expect(session.state.status).toBe('sent');
      expect(session.state.chatId).toBe('oc_group');
      expect(session.state.messageId).toBe('om_msg');
      expect(session.state.sentAt).toBeDefined();
    });

    it('should throw for non-existent session', async () => {
      await expect(
        manager.markAsSent('non-existent', 'oc_xxx', 'om_xxx'),
      ).rejects.toThrow('Session not found');
    });

    it('should throw for invalid state transition', async () => {
      await manager.create({
        id: 'test-invalid',
        config: {
          type: 'blocking',
          purpose: 'pr-review',
          channel: { type: 'group', name: 'PR #123' },
          expiresIn: '24h',
        },
      });

      // First mark as sent (valid)
      await manager.markAsSent('test-invalid', 'oc_group', 'om_msg');

      // Try to mark as sent again (invalid)
      await expect(
        manager.markAsSent('test-invalid', 'oc_group2', 'om_msg2'),
      ).rejects.toThrow('Invalid state transition');
    });

    it('should persist state change to disk', async () => {
      await manager.create({
        id: 'persist-test',
        config: {
          type: 'blocking',
          purpose: 'pr-review',
          channel: { type: 'group', name: 'PR #123' },
          expiresIn: '24h',
        },
      });

      await manager.markAsSent('persist-test', 'oc_group', 'om_msg');

      // Re-read from disk
      const reloaded = await manager.get('persist-test');
      expect(reloaded!.state.status).toBe('sent');
      expect(reloaded!.state.chatId).toBe('oc_group');
    });
  });

  describe('recordResponse', () => {
    it('should transition sent → replied', async () => {
      await manager.create({
        id: 'test-response',
        config: {
          type: 'blocking',
          purpose: 'pr-review',
          channel: { type: 'group', name: 'PR #123' },
          expiresIn: '24h',
        },
      });
      await manager.markAsSent('test-response', 'oc_group', 'om_msg');

      const session = await manager.recordResponse('test-response', {
        selectedValue: 'merge',
        responder: 'ou_developer',
        repliedAt: '2026-03-10T14:30:00Z',
      });

      expect(session.state.status).toBe('replied');
      expect(session.state.response).toEqual({
        selectedValue: 'merge',
        responder: 'ou_developer',
        repliedAt: '2026-03-10T14:30:00Z',
      });
    });

    it('should throw for non-existent session', async () => {
      await expect(
        manager.recordResponse('non-existent', {
          selectedValue: 'merge',
          responder: 'ou_xxx',
          repliedAt: new Date().toISOString(),
        }),
      ).rejects.toThrow('Session not found');
    });

    it('should throw for pending session (not sent yet)', async () => {
      await manager.create({
        id: 'test-pending-response',
        config: {
          type: 'blocking',
          purpose: 'pr-review',
          channel: { type: 'group', name: 'PR #123' },
          expiresIn: '24h',
        },
      });

      await expect(
        manager.recordResponse('test-pending-response', {
          selectedValue: 'merge',
          responder: 'ou_xxx',
          repliedAt: new Date().toISOString(),
        }),
      ).rejects.toThrow('Invalid state transition');
    });

    it('should persist response to disk', async () => {
      await manager.create({
        id: 'persist-response',
        config: {
          type: 'blocking',
          purpose: 'pr-review',
          channel: { type: 'group', name: 'PR #123' },
          expiresIn: '24h',
        },
      });
      await manager.markAsSent('persist-response', 'oc_group', 'om_msg');

      await manager.recordResponse('persist-response', {
        selectedValue: 'close',
        responder: 'ou_reviewer',
        repliedAt: '2026-03-10T15:00:00Z',
      });

      const reloaded = await manager.get('persist-response');
      expect(reloaded!.state.response?.selectedValue).toBe('close');
      expect(reloaded!.state.response?.responder).toBe('ou_reviewer');
    });
  });

  describe('markAsExpired', () => {
    it('should transition sent → expired', async () => {
      await manager.create({
        id: 'test-expire',
        config: {
          type: 'blocking',
          purpose: 'pr-review',
          channel: { type: 'group', name: 'PR #123' },
          expiresIn: '1h',
        },
      });
      await manager.markAsSent('test-expire', 'oc_group', 'om_msg');

      const session = await manager.markAsExpired('test-expire');
      expect(session.state.status).toBe('expired');
    });

    it('should return as-is for non-sent sessions', async () => {
      await manager.create({
        id: 'test-no-expire',
        config: {
          type: 'blocking',
          purpose: 'pr-review',
          channel: { type: 'group', name: 'PR #123' },
          expiresIn: '24h',
        },
      });

      // pending session
      const session = await manager.markAsExpired('test-no-expire');
      expect(session.state.status).toBe('pending');
    });

    it('should throw for non-existent session', async () => {
      await expect(manager.markAsExpired('non-existent')).rejects.toThrow(
        'Session not found',
      );
    });
  });

  // ============================================================================
  // findByMessageId
  // ============================================================================

  describe('findByMessageId', () => {
    it('should find session by message ID', async () => {
      await manager.create({
        id: 'find-test',
        config: {
          type: 'blocking',
          purpose: 'pr-review',
          channel: { type: 'group', name: 'PR #123' },
          expiresIn: '24h',
        },
      });
      await manager.markAsSent('find-test', 'oc_group', 'om_unique_msg_id');

      const found = await manager.findByMessageId('om_unique_msg_id');
      expect(found).toBeDefined();
      expect(found!.id).toBe('find-test');
    });

    it('should return undefined for unknown message ID', async () => {
      const found = await manager.findByMessageId('om_unknown');
      expect(found).toBeUndefined();
    });
  });

  // ============================================================================
  // Delete & Cleanup
  // ============================================================================

  describe('delete', () => {
    it('should delete a session folder', async () => {
      await manager.create({
        id: 'delete-test',
        config: {
          type: 'blocking',
          purpose: 'pr-review',
          channel: { type: 'group', name: 'PR #123' },
          expiresIn: '24h',
        },
      });

      expect(await manager.get('delete-test')).toBeDefined();
      await manager.delete('delete-test');
      expect(await manager.get('delete-test')).toBeUndefined();
    });

    it('should not throw for non-existent session', async () => {
      await expect(manager.delete('non-existent')).resolves.not.toThrow();
    });
  });

  describe('cleanupExpired', () => {
    it('should delete old expired sessions', async () => {
      // Create a session with very old creation time
      const oldDir = path.join(tempDir, 'old-expired');
      await fsPromises.mkdir(oldDir, { recursive: true });

      const configContent = `---\ntype: blocking\npurpose: pr-review\nchannel:\n  type: group\n  name: Old PR\nexpiresIn: 1h\n---\n`;
      await fsPromises.writeFile(
        path.join(oldDir, 'session.md'),
        configContent,
      );
      const state: SessionState = {
        status: 'expired',
        createdAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-02T00:00:00.000Z',
      };
      const yaml = await import('js-yaml');
      await fsPromises.writeFile(
        path.join(oldDir, 'state.yaml'),
        yaml.dump(state),
      );

      // Create a recent session that should NOT be cleaned up
      await manager.create({
        id: 'recent-session',
        config: {
          type: 'blocking',
          purpose: 'pr-review',
          channel: { type: 'group', name: 'Recent PR' },
          expiresIn: '24h',
        },
      });

      const deleted = await manager.cleanupExpired();

      expect(deleted).toBe(1);
      expect(await manager.get('old-expired')).toBeUndefined();
      expect(await manager.get('recent-session')).toBeDefined();
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('edge cases', () => {
    it('should handle special characters in session ID', async () => {
      await manager.create({
        id: 'pr-123_fix-auth',
        config: {
          type: 'blocking',
          purpose: 'pr-review',
          channel: { type: 'group', name: 'PR #123: Fix Auth' },
          expiresIn: '24h',
        },
      });

      const session = await manager.get('pr-123_fix-auth');
      expect(session).toBeDefined();
    });

    it('should handle non-blocking session type', async () => {
      const session = await manager.create({
        id: 'non-blocking-test',
        config: {
          type: 'non-blocking',
          purpose: 'offline-question',
          channel: { type: 'existing', chatId: 'oc_xxx' },
          expiresIn: '1h',
        },
      });

      expect(session.config.type).toBe('non-blocking');
      expect(session.config.purpose).toBe('offline-question');
    });

    it('should handle custom purpose', async () => {
      const session = await manager.create({
        id: 'custom-purpose',
        config: {
          type: 'blocking',
          purpose: 'custom',
          channel: { type: 'existing', chatId: 'oc_xxx' },
          expiresIn: '12h',
          context: { customField: 'customValue' },
        },
      });

      expect(session.config.purpose).toBe('custom');
      expect(session.config.context?.customField).toBe('customValue');
    });

    it('should handle sessions without options', async () => {
      const session = await manager.create({
        id: 'no-options',
        config: {
          type: 'non-blocking',
          purpose: 'offline-question',
          channel: { type: 'existing', chatId: 'oc_xxx' },
          expiresIn: '1h',
        },
      });

      expect(session.config.options).toBeUndefined();
    });

    it('should handle response with text input', async () => {
      await manager.create({
        id: 'text-input-test',
        config: {
          type: 'blocking',
          purpose: 'agent-confirm',
          channel: { type: 'existing', chatId: 'oc_xxx' },
          expiresIn: '24h',
        },
      });
      await manager.markAsSent('text-input-test', 'oc_xxx', 'om_xxx');

      const session = await manager.recordResponse('text-input-test', {
        selectedValue: 'custom',
        responder: 'ou_xxx',
        repliedAt: new Date().toISOString(),
        textInput: 'User provided custom feedback',
      });

      expect(session.state.response?.textInput).toBe('User provided custom feedback');
    });
  });
});
