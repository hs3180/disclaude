/**
 * Unit tests for chats-activation schedule script.
 *
 * These tests validate the validation and file handling logic by importing
 * and testing the shared schema functions. The full activation flow (including
 * lark-cli calls) is tested indirectly via the create.test.ts integration tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseChatFile,
  CHAT_DIR,
  type ChatFile,
} from '../schema.js';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const CHAT_DIR_RESOLVED = resolve(PROJECT_ROOT, CHAT_DIR);

const TEST_IDS = ['test-act-expired', 'test-act-active', 'test-act-pending'];

async function cleanupTestFiles() {
  for (const id of TEST_IDS) {
    try {
      await rm(resolve(CHAT_DIR_RESOLVED, `${id}.json`), { force: true });
      await rm(resolve(CHAT_DIR_RESOLVED, `${id}.json.lock`), { force: true });
    } catch {
      // Ignore
    }
  }
}

function makeChatData(id: string, status: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status,
    chatId: status === 'active' ? 'oc_existing' : null,
    createdAt: '2026-01-01T00:00:00Z',
    activatedAt: status === 'active' ? '2026-01-01T00:01:00Z' : null,
    expiresAt: '2099-12-31T23:59:59Z',
    createGroup: { name: 'Test Group', members: ['ou_test123'] },
    context: {},
    response: null,
    activationAttempts: 0,
    lastActivationError: null,
    failedAt: null,
    ...overrides,
  };
}

describe('chats-activation', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR_RESOLVED, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  describe('schema validation for activation', () => {
    it('should correctly identify pending chats for activation', async () => {
      const chatData = makeChatData('test-act-pending', 'pending');
      const content = JSON.stringify(chatData, null, 2);
      const chat = parseChatFile(content, 'test-act-pending.json');
      expect(chat.status).toBe('pending');
      expect(chat.createGroup.members).toEqual(['ou_test123']);
      expect(chat.activationAttempts).toBe(0);
    });

    it('should correctly identify expired chats', async () => {
      const chatData = makeChatData('test-act-expired', 'pending', {
        expiresAt: '2020-01-01T00:00:00Z',
      });
      const content = JSON.stringify(chatData, null, 2);
      const chat = parseChatFile(content, 'test-act-expired.json');
      expect(chat.status).toBe('pending');
      expect(chat.expiresAt < new Date().toISOString()).toBe(true);
    });

    it('should correctly identify active chats (skip during activation)', async () => {
      const chatData = makeChatData('test-act-active', 'active', {
        chatId: 'oc_existing',
        activatedAt: '2026-01-01T00:01:00Z',
      });
      const content = JSON.stringify(chatData, null, 2);
      const chat = parseChatFile(content, 'test-act-active.json');
      expect(chat.status).toBe('active');
      expect(chat.chatId).toBe('oc_existing');
    });

    it('should handle chats with retry history', () => {
      const chatData = makeChatData('test-act-pending', 'pending', {
        activationAttempts: 3,
        lastActivationError: 'lark-cli timeout after 30s',
      });
      const content = JSON.stringify(chatData, null, 2);
      const chat = parseChatFile(content, 'test-act-pending.json');
      expect(chat.activationAttempts).toBe(3);
      expect(chat.lastActivationError).toBe('lark-cli timeout after 30s');
    });

    it('should handle chats at max retries', () => {
      const chatData = makeChatData('test-act-pending', 'pending', {
        activationAttempts: 5,
        lastActivationError: 'Invalid members',
      });
      const content = JSON.stringify(chatData, null, 2);
      const chat = parseChatFile(content, 'test-act-pending.json');
      expect(chat.activationAttempts).toBe(5);
    });
  });

  describe('file integrity', () => {
    it('should reject corrupted chat files', () => {
      expect(() => parseChatFile('not valid json', 'corrupted.json')).toThrow();
    });

    it('should reject chat files with invalid status', () => {
      const badData = { ...makeChatData('test', 'invalid_status') };
      expect(() => parseChatFile(JSON.stringify(badData), 'bad.json')).toThrow();
    });

    it('should reject chat files missing required fields', () => {
      expect(() => parseChatFile('{}', 'empty.json')).toThrow();
    });
  });

  describe('expiry transition logic', () => {
    it('should detect expired chats by comparing timestamps', async () => {
      const expiredChat = makeChatData('test-act-expired', 'pending', {
        expiresAt: '2020-01-01T00:00:00Z',
      });
      const content = JSON.stringify(expiredChat, null, 2);
      const chat = parseChatFile(content, 'test-act-expired.json');

      const now = new Date().toISOString();
      // Simulate the expiry check logic from chats-activation.ts
      const isExpired = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(chat.expiresAt) && chat.expiresAt < now;
      expect(isExpired).toBe(true);
    });

    it('should not mark non-expired chats', async () => {
      const futureChat = makeChatData('test-act-pending', 'pending', {
        expiresAt: '2099-12-31T23:59:59Z',
      });
      const content = JSON.stringify(futureChat, null, 2);
      const chat = parseChatFile(content, 'test-act-pending.json');

      const now = new Date().toISOString();
      const isExpired = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(chat.expiresAt) && chat.expiresAt < now;
      expect(isExpired).toBe(false);
    });
  });

  describe('idempotent recovery', () => {
    it('should detect chats with existing chatId for recovery', () => {
      const chatData = makeChatData('test-act-pending', 'pending', {
        chatId: 'oc_already_created',
      });
      const content = JSON.stringify(chatData, null, 2);
      const chat = parseChatFile(content, 'test-act-pending.json');

      // Simulate the idempotent recovery check
      const needsRecovery = chat.status === 'pending' && chat.chatId !== null;
      expect(needsRecovery).toBe(true);
    });

    it('should not trigger recovery for chats without chatId', () => {
      const chatData = makeChatData('test-act-pending', 'pending');
      const content = JSON.stringify(chatData, null, 2);
      const chat = parseChatFile(content, 'test-act-pending.json');

      const needsRecovery = chat.status === 'pending' && chat.chatId !== null;
      expect(needsRecovery).toBe(false);
    });
  });
});
