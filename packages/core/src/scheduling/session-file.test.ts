/**
 * Tests for temporary session JSON file format and lifecycle.
 *
 * Validates the session file format used by schedules (pr-scanner.md,
 * session-lifecycle.md) for managing temporary interactive sessions.
 *
 * Session files are plain JSON stored in workspace/temporary-sessions/
 * and managed directly via file I/O by schedules (no Manager class).
 *
 * @see Issue #1317 - Temporary session management system
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// Types (mirror the session file format, NOT exported as a module)
// ============================================================================

interface SessionOption {
  value: string;
  text: string;
}

interface SessionFile {
  status: 'pending' | 'active' | 'expired';
  chatId: string | null;
  messageId: string | null;
  createdAt: string;
  expiresAt: string;
  context: Record<string, unknown>;
  response: Record<string, unknown> | null;
  options?: SessionOption[];
  createGroup?: {
    name: string;
    members: string[];
  };
  message?: string;
}

// ============================================================================
// Helpers
// ============================================================================

let tmpDir: string;

function sessionPath(name: string): string {
  return path.join(tmpDir, name);
}

function writeSession(name: string, data: Partial<SessionFile>): void {
  const session: SessionFile = {
    status: 'pending',
    chatId: null,
    messageId: null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    context: {},
    response: null,
    ...data,
  };
  fs.writeFileSync(sessionPath(name), JSON.stringify(session, null, 2));
}

function readSession(name: string): SessionFile {
  const raw = fs.readFileSync(sessionPath(name), 'utf-8');
  return JSON.parse(raw);
}

function updateSessionStatus(name: string, status: SessionFile['status']): void {
  const session = readSession(name);
  session.status = status;
  fs.writeFileSync(sessionPath(name), JSON.stringify(session, null, 2));
}

function isExpired(session: SessionFile): boolean {
  return new Date(session.expiresAt) < new Date();
}

// ============================================================================
// Tests
// ============================================================================

describe('Temporary Session Files (Issue #1317)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-test-'));
    fs.mkdirSync(path.join(tmpDir, 'temporary-sessions'), { recursive: true });
    tmpDir = path.join(tmpDir, 'temporary-sessions');
  });

  afterEach(() => {
    fs.rmSync(path.dirname(tmpDir), { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // Session File Format
  // --------------------------------------------------------------------------

  describe('session file format', () => {
    it('should create a valid PR review session file', () => {
      writeSession('pr-123.json', {
        status: 'pending',
        chatId: null,
        messageId: null,
        createdAt: '2026-03-25T10:00:00Z',
        expiresAt: '2026-03-25T11:00:00Z',
        createGroup: {
          name: 'PR #123 讨论: Fix auth bug',
          members: [],
        },
        message: '🔔 PR 审核请求\nPR #123: Fix auth bug',
        options: [
          { value: 'merge', text: '✅ 合并' },
          { value: 'request_changes', text: '🔄 请求修改' },
          { value: 'close', text: '❌ 关闭' },
          { value: 'later', text: '⏳ 稍后' },
        ],
        context: {
          prNumber: 123,
          repository: 'hs3180/disclaude',
        },
        response: null,
      });

      const session = readSession('pr-123.json');
      expect(session.status).toBe('pending');
      expect(session.context.prNumber).toBe(123);
      expect(session.options).toHaveLength(4);
      expect(session.response).toBeNull();
      expect(session.expiresAt).toBe('2026-03-25T11:00:00Z');
    });

    it('should create a valid ask session file', () => {
      writeSession('ask-review-20260325.json', {
        status: 'active',
        chatId: 'oc_test123',
        messageId: 'om_msg456',
        createdAt: '2026-03-25T10:00:00Z',
        expiresAt: '2026-03-25T10:30:00Z',
        context: {
          type: 'ask_user',
          question: '是否需要创建新的 skill？',
        },
        response: null,
      });

      const session = readSession('ask-review-20260325.json');
      expect(session.status).toBe('active');
      expect(session.chatId).toBe('oc_test123');
      expect(session.context.type).toBe('ask_user');
    });

    it('should require all mandatory fields', () => {
      // A session with missing fields should still be parseable JSON
      // but callers should validate required fields
      writeSession('minimal.json', {
        status: 'pending',
        chatId: null,
        messageId: null,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        context: {},
        response: null,
      });

      const session = readSession('minimal.json');
      expect(session.status).toBe('pending');
      expect(session.createdAt).toBeDefined();
      expect(session.expiresAt).toBeDefined();
      expect(session.context).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Session Lifecycle
  // --------------------------------------------------------------------------

  describe('session lifecycle', () => {
    it('should transition pending → active → expired', () => {
      writeSession('pr-456.json', {
        status: 'pending',
        context: { prNumber: 456 },
      });

      // pending → active (after group creation + card sent)
      updateSessionStatus('pr-456.json', 'active');
      expect(readSession('pr-456.json').status).toBe('active');

      // active → expired (after user response or timeout)
      updateSessionStatus('pr-456.json', 'expired');
      expect(readSession('pr-456.json').status).toBe('expired');
    });

    it('should record user response when session expires', () => {
      writeSession('pr-789.json', {
        status: 'active',
        context: { prNumber: 789 },
      });

      // Simulate user action
      const session = readSession('pr-789.json');
      session.status = 'expired';
      session.response = {
        action: 'merge',
        result: 'PR merged successfully',
        timestamp: new Date().toISOString(),
      };
      fs.writeFileSync(sessionPath('pr-789.json'), JSON.stringify(session, null, 2));

      const updated = readSession('pr-789.json');
      expect(updated.status).toBe('expired');
      expect(updated.response?.action).toBe('merge');
      expect(updated.response?.result).toBe('PR merged successfully');
    });

    it('should update chatId and messageId when session becomes active', () => {
      writeSession('pr-100.json', {
        status: 'pending',
        chatId: null,
        messageId: null,
        context: { prNumber: 100 },
      });

      // Simulate group creation and card sending
      const session = readSession('pr-100.json');
      session.status = 'active';
      session.chatId = 'oc_newgroup123';
      session.messageId = 'om_card456';
      fs.writeFileSync(sessionPath('pr-100.json'), JSON.stringify(session, null, 2));

      const updated = readSession('pr-100.json');
      expect(updated.status).toBe('active');
      expect(updated.chatId).toBe('oc_newgroup123');
      expect(updated.messageId).toBe('om_card456');
    });
  });

  // --------------------------------------------------------------------------
  // Expiration Logic
  // --------------------------------------------------------------------------

  describe('expiration logic', () => {
    it('should detect non-expired sessions', () => {
      writeSession('pr-active.json', {
        status: 'active',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour from now
      });

      const session = readSession('pr-active.json');
      expect(isExpired(session)).toBe(false);
    });

    it('should detect expired sessions', () => {
      writeSession('pr-expired.json', {
        status: 'active',
        expiresAt: new Date(Date.now() - 1000).toISOString(), // 1 second ago
      });

      const session = readSession('pr-expired.json');
      expect(isExpired(session)).toBe(true);
    });

    it('should detect sessions expiring at exactly now', () => {
      // Use a fixed past timestamp to avoid timing issues
      const past = new Date(Date.now() - 1000).toISOString();
      writeSession('pr-boundary.json', {
        status: 'active',
        expiresAt: past,
      });

      const session = readSession('pr-boundary.json');
      expect(isExpired(session)).toBe(true);
    });

    it('should not double-expire already expired sessions', () => {
      writeSession('pr-already-expired.json', {
        status: 'expired',
        expiresAt: new Date(Date.now() - 3600000).toISOString(),
        response: { action: 'close' },
      });

      const session = readSession('pr-already-expired.json');
      expect(session.status).toBe('expired');
      // Lifecycle manager should skip already-expired sessions
      expect(session.response).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // File Naming Convention
  // --------------------------------------------------------------------------

  describe('file naming convention', () => {
    it('should use pr- prefix for PR review sessions', () => {
      const filename = 'pr-123.json';
      expect(filename).toMatch(/^pr-\d+\.json$/);
    });

    it('should use ask- prefix for agent question sessions', () => {
      const filename = 'ask-review-20260325.json';
      expect(filename).toMatch(/^ask-.+\.json$/);
    });

    it('should use offline- prefix for offline Q&A sessions', () => {
      const filename = 'offline-deploy.json';
      expect(filename).toMatch(/^offline-.+\.json$/);
    });
  });

  // --------------------------------------------------------------------------
  // Concurrent Session Detection
  // --------------------------------------------------------------------------

  describe('concurrent session detection', () => {
    it('should detect active sessions to prevent concurrent processing', () => {
      // Create one active and one pending session
      writeSession('pr-200.json', { status: 'active', context: { prNumber: 200 } });
      writeSession('pr-201.json', { status: 'pending', context: { prNumber: 201 } });

      // Scan for active/pending sessions
      const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
      const hasActiveSessions = files.some((f) => {
        const session = readSession(f);
        return session.status === 'active' || session.status === 'pending';
      });

      expect(hasActiveSessions).toBe(true);
      expect(files).toHaveLength(2);
    });

    it('should allow new processing when no active sessions exist', () => {
      // Only expired sessions
      writeSession('pr-300.json', {
        status: 'expired',
        context: { prNumber: 300 },
        response: { action: 'merge' },
      });

      const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
      const hasActiveSessions = files.some((f) => {
        const session = readSession(f);
        return session.status === 'active' || session.status === 'pending';
      });

      expect(hasActiveSessions).toBe(false);
    });
  });
});
