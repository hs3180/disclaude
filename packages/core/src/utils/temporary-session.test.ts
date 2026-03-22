/**
 * Tests for Temporary Session Manager
 *
 * @see Issue #1391 - 临时会话管理系统
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TemporarySessionManager,
  resetSessionManager,
  type SessionResponse,
} from './temporary-session.js';

describe('TemporarySessionManager', () => {
  let manager: TemporarySessionManager;
  let tempDir: string;

  beforeEach(() => {
    // Create temp directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-test-'));
    manager = new TemporarySessionManager(tempDir);
    resetSessionManager();
  });

  afterEach(() => {
    // Cleanup temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('should create a session with pending status', () => {
      const session = manager.create({
        name: 'Test Session',
        message: 'Please confirm',
        options: [
          { value: 'yes', text: 'Yes' },
          { value: 'no', text: 'No' },
        ],
        context: { source: 'test' },
      });

      expect(session.id).toBeDefined();
      expect(session.status).toBe('pending');
      expect(session.chatId).toBeNull();
      expect(session.messageId).toBeNull();
      expect(session.createGroup.name).toBe('Test Session');
      expect(session.message).toBe('Please confirm');
      expect(session.options).toHaveLength(2);
      expect(session.context.source).toBe('test');
    });

    it('should create session with custom id', () => {
      const session = manager.create({
        id: 'custom-session-id',
        name: 'Test',
        message: 'Test',
        options: [{ value: 'ok', text: 'OK' }],
        context: {},
      });

      expect(session.id).toBe('custom-session-id');
    });

    it('should throw error if session already exists', () => {
      manager.create({
        id: 'duplicate-id',
        name: 'First',
        message: 'Test',
        options: [{ value: 'ok', text: 'OK' }],
        context: {},
      });

      expect(() => {
        manager.create({
          id: 'duplicate-id',
          name: 'Second',
          message: 'Test',
          options: [{ value: 'ok', text: 'OK' }],
          context: {},
        });
      }).toThrow('Session already exists');
    });

    it('should set expiration time based on timeoutMinutes', () => {
      const beforeCreate = Date.now();
      const session = manager.create({
        name: 'Test',
        message: 'Test',
        options: [{ value: 'ok', text: 'OK' }],
        context: {},
        timeoutMinutes: 30,
      });
      const afterCreate = Date.now();

      const expectedMin = beforeCreate + 30 * 60 * 1000;
      const expectedMax = afterCreate + 30 * 60 * 1000;
      const actualExpires = new Date(session.expiresAt).getTime();

      expect(actualExpires).toBeGreaterThanOrEqual(expectedMin);
      expect(actualExpires).toBeLessThanOrEqual(expectedMax);
    });
  });

  describe('get', () => {
    it('should return session by id', () => {
      manager.create({
        id: 'get-test',
        name: 'Test',
        message: 'Test',
        options: [{ value: 'ok', text: 'OK' }],
        context: { foo: 'bar' },
      });

      const session = manager.get('get-test');

      expect(session).toBeDefined();
      expect(session?.id).toBe('get-test');
      expect(session?.context.foo).toBe('bar');
    });

    it('should return undefined for non-existent session', () => {
      const session = manager.get('non-existent');
      expect(session).toBeUndefined();
    });
  });

  describe('update', () => {
    it('should update session fields', () => {
      manager.create({
        id: 'update-test',
        name: 'Original',
        message: 'Test',
        options: [{ value: 'ok', text: 'OK' }],
        context: {},
      });

      const updated = manager.update('update-test', {
        status: 'active',
        chatId: 'oc_test_chat',
        messageId: 'om_test_message',
      });

      expect(updated?.status).toBe('active');
      expect(updated?.chatId).toBe('oc_test_chat');
      expect(updated?.messageId).toBe('om_test_message');
    });

    it('should return undefined for non-existent session', () => {
      const updated = manager.update('non-existent', { status: 'active' });
      expect(updated).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('should delete existing session', () => {
      manager.create({
        id: 'delete-test',
        name: 'Test',
        message: 'Test',
        options: [{ value: 'ok', text: 'OK' }],
        context: {},
      });

      const result = manager.delete('delete-test');
      expect(result).toBe(true);
      expect(manager.get('delete-test')).toBeUndefined();
    });

    it('should return false for non-existent session', () => {
      const result = manager.delete('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('findByMessageId', () => {
    it('should find session by messageId', () => {
      manager.create({
        id: 'find-msg-test',
        name: 'Test',
        message: 'Test',
        options: [{ value: 'ok', text: 'OK' }],
        context: {},
      });

      manager.update('find-msg-test', {
        messageId: 'om_special_message',
      });

      const session = manager.findByMessageId('om_special_message');
      expect(session?.id).toBe('find-msg-test');
    });

    it('should return undefined if not found', () => {
      const session = manager.findByMessageId('non_existent_message');
      expect(session).toBeUndefined();
    });
  });

  describe('findByChatId', () => {
    it('should find session by chatId', () => {
      manager.create({
        id: 'find-chat-test',
        name: 'Test',
        message: 'Test',
        options: [{ value: 'ok', text: 'OK' }],
        context: {},
      });

      manager.update('find-chat-test', {
        chatId: 'oc_special_chat',
      });

      const session = manager.findByChatId('oc_special_chat');
      expect(session?.id).toBe('find-chat-test');
    });
  });

  describe('listByStatus', () => {
    it('should list sessions by status', () => {
      manager.create({
        id: 'pending-1',
        name: 'Pending 1',
        message: 'Test',
        options: [{ value: 'ok', text: 'OK' }],
        context: {},
      });

      manager.create({
        id: 'pending-2',
        name: 'Pending 2',
        message: 'Test',
        options: [{ value: 'ok', text: 'OK' }],
        context: {},
      });

      manager.create({
        id: 'active-1',
        name: 'Active 1',
        message: 'Test',
        options: [{ value: 'ok', text: 'OK' }],
        context: {},
      });
      manager.update('active-1', { status: 'active', chatId: 'oc_test' });

      const pending = manager.listByStatus('pending');
      const active = manager.listByStatus('active');

      expect(pending).toHaveLength(2);
      expect(active).toHaveLength(1);
    });
  });

  describe('checkExpired', () => {
    it('should expire sessions past expiration time', () => {
      // Create session that expires in the past
      manager.create({
        id: 'expired-test',
        name: 'Test',
        message: 'Test',
        options: [{ value: 'ok', text: 'OK' }],
        context: {},
        timeoutMinutes: -1, // Already expired
      });

      // Set to active
      manager.update('expired-test', { status: 'active', chatId: 'oc_test' });

      const expiredCount = manager.checkExpired();

      expect(expiredCount).toBe(1);

      const updated = manager.get('expired-test');
      expect(updated?.status).toBe('expired');
    });

    it('should not expire pending sessions', () => {
      manager.create({
        id: 'pending-expired',
        name: 'Test',
        message: 'Test',
        options: [{ value: 'ok', text: 'OK' }],
        context: {},
        timeoutMinutes: -1,
      });

      const expiredCount = manager.checkExpired();

      expect(expiredCount).toBe(0);

      const session = manager.get('pending-expired');
      expect(session?.status).toBe('pending');
    });
  });

  describe('recordResponse', () => {
    it('should record user response and set status to expired', () => {
      manager.create({
        id: 'response-test',
        name: 'Test',
        message: 'Test',
        options: [{ value: 'ok', text: 'OK' }],
        context: {},
      });

      const response: SessionResponse = {
        selectedValue: 'ok',
        responder: 'ou_test_user',
        respondedAt: new Date().toISOString(),
      };

      const updated = manager.recordResponse('response-test', response);

      expect(updated?.status).toBe('expired');
      expect(updated?.response?.selectedValue).toBe('ok');
      expect(updated?.response?.responder).toBe('ou_test_user');
    });
  });
});
