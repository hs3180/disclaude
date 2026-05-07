/**
 * Tests for NonUserMessage type definitions.
 *
 * Verifies type interfaces and structural contracts.
 * Since these are pure type definitions with no runtime logic,
 * tests focus on structural validation and documentation.
 *
 * Issue #3333: Scheduler integration with NonUserMessage (Phase 3).
 */

import { describe, it, expect } from 'vitest';
import type {
  NonUserMessage,
  NonUserMessagePriority,
  ProjectRoutingConfig,
  RouteResult,
} from './types.js';

describe('NonUserMessage types', () => {
  describe('NonUserMessage', () => {
    it('should construct a valid scheduled NonUserMessage', () => {
      const message: NonUserMessage = {
        id: 'msg-001',
        type: 'scheduled',
        source: 'scheduler:daily-report',
        projectKey: 'hs3180/disclaude',
        payload: 'Check for new issues',
        priority: 'normal',
        createdAt: '2026-05-06T09:00:00Z',
      };

      expect(message.type).toBe('scheduled');
      expect(message.projectKey).toBe('hs3180/disclaude');
      expect(message.priority).toBe('normal');
    });

    it('should construct a valid a2a NonUserMessage', () => {
      const message: NonUserMessage = {
        id: 'msg-002',
        type: 'a2a',
        source: 'a2a:chat:oc_xxx',
        projectKey: 'owner/repo',
        payload: 'Analyze the codebase',
        priority: 'high',
        createdAt: '2026-05-06T10:00:00Z',
      };

      expect(message.type).toBe('a2a');
      expect(message.priority).toBe('high');
    });

    it('should support all priority levels', () => {
      const priorities: NonUserMessagePriority[] = ['low', 'normal', 'high'];
      for (const priority of priorities) {
        const message: NonUserMessage = {
          id: `msg-${priority}`,
          type: 'system',
          source: 'system:test',
          projectKey: 'test/project',
          payload: 'test',
          priority,
          createdAt: '2026-05-06T00:00:00Z',
        };
        expect(message.priority).toBe(priority);
      }
    });
  });

  describe('ProjectRoutingConfig', () => {
    it('should construct a valid routing config', () => {
      const config: ProjectRoutingConfig = {
        key: 'hs3180/disclaude',
        chatId: 'oc_abc123',
        workingDir: '/workspace/disclaude',
      };

      expect(config.key).toBe('hs3180/disclaude');
      expect(config.chatId).toBe('oc_abc123');
      expect(config.workingDir).toBe('/workspace/disclaude');
    });

    it('should include optional modelTier', () => {
      const config: ProjectRoutingConfig = {
        key: 'hs3180/disclaude',
        chatId: 'oc_abc123',
        workingDir: '/workspace/disclaude',
        modelTier: 'low',
      };

      expect(config.modelTier).toBe('low');
    });
  });

  describe('RouteResult', () => {
    it('should represent success', () => {
      const result: RouteResult = { ok: true };
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should represent failure with error message', () => {
      const result: RouteResult = { ok: false, error: 'Project not found' };
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Project not found');
    });
  });
});
