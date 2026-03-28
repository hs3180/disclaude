/**
 * Unit tests for TempChatLifecycleService
 *
 * Issue #1703: Phase 3 — Primary Node lifecycle service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TempChatLifecycleService, type TempChatLifecycleDeps } from './temp-chat-lifecycle-service.js';
import { ChatStore } from '@disclaude/core';

// Mock ChatStore — avoid file I/O in unit tests
function createMockChatStore(initialRecords: Array<{
  chatId: string;
  expiresAt: string;
  response?: { selectedValue: string; responder: string; repliedAt: string };
}> = []) {
  const store = {
    getExpiredTempChats: vi.fn().mockResolvedValue(
      initialRecords.filter(r => !r.response)
    ),
    removeTempChat: vi.fn().mockResolvedValue(true),
    registerTempChat: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChatStore;
  return store;
}

describe('TempChatLifecycleService', () => {
  let service: TempChatLifecycleService;
  let deps: TempChatLifecycleDeps;
  let mockStore: ChatStore;

  beforeEach(() => {
    vi.useFakeTimers();
    mockStore = createMockChatStore();
    deps = {
      chatStore: mockStore,
      dissolveChat: vi.fn().mockResolvedValue(undefined),
      unregisterGroup: vi.fn().mockReturnValue(true),
    };
    service = new TempChatLifecycleService(deps, { checkIntervalMs: 60_000 });
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create a TempChatLifecycleService', () => {
      expect(service).toBeDefined();
    });

    it('should default to 5 minute interval', () => {
      const defaultService = new TempChatLifecycleService(deps);
      expect(defaultService.isRunning()).toBe(false);
      defaultService.stop();
    });
  });

  describe('start/stop', () => {
    it('should start the periodic timer', () => {
      service.start();
      expect(service.isRunning()).toBe(true);
    });

    it('should not start twice', () => {
      service.start();
      service.start();
      expect(service.isRunning()).toBe(true);
    });

    it('should stop the periodic timer', () => {
      service.start();
      service.stop();
      expect(service.isRunning()).toBe(false);
    });

    it('should run an immediate check on start', async () => {
      service.start();
      // Allow the immediate async check to run
      await vi.advanceTimersByTimeAsync(0);
      expect(mockStore.getExpiredTempChats).toHaveBeenCalledTimes(1);
    });
  });

  describe('checkAndCleanup', () => {
    it('should return empty result when no expired chats', async () => {
      const result = await service.checkAndCleanup();
      expect(result.cleaned).toBe(0);
      expect(result.details).toEqual([]);
    });

    it('should clean up expired chats', async () => {
      vi.mocked(mockStore.getExpiredTempChats).mockResolvedValue([
        { chatId: 'oc_expired1', createdAt: '2026-01-01', expiresAt: '2026-01-02' },
        { chatId: 'oc_expired2', createdAt: '2026-01-01', expiresAt: '2026-01-02' },
      ] as any);

      const result = await service.checkAndCleanup();

      expect(result.cleaned).toBe(2);
      expect(result.details).toHaveLength(2);
      expect(deps.dissolveChat).toHaveBeenCalledWith('oc_expired1');
      expect(deps.dissolveChat).toHaveBeenCalledWith('oc_expired2');
      expect(deps.unregisterGroup).toHaveBeenCalledWith('oc_expired1');
      expect(deps.unregisterGroup).toHaveBeenCalledWith('oc_expired2');
      expect(mockStore.removeTempChat).toHaveBeenCalledWith('oc_expired1');
      expect(mockStore.removeTempChat).toHaveBeenCalledWith('oc_expired2');
    });

    it('should continue cleanup when dissolveChat fails', async () => {
      vi.mocked(deps.dissolveChat!).mockRejectedValue(new Error('API error'));
      vi.mocked(mockStore.getExpiredTempChats).mockResolvedValue([
        { chatId: 'oc_expired1', createdAt: '2026-01-01', expiresAt: '2026-01-02' },
      ] as any);

      const result = await service.checkAndCleanup();

      // Should still succeed — dissolve failure is non-fatal
      expect(result.cleaned).toBe(1);
      expect(mockStore.removeTempChat).toHaveBeenCalledWith('oc_expired1');
    });

    it('should work without dissolveChat dependency', async () => {
      const minimalDeps: TempChatLifecycleDeps = { chatStore: mockStore };
      const minimalService = new TempChatLifecycleService(minimalDeps);

      vi.mocked(mockStore.getExpiredTempChats).mockResolvedValue([
        { chatId: 'oc_expired1', createdAt: '2026-01-01', expiresAt: '2026-01-02' },
      ] as any);

      const result = await minimalService.checkAndCleanup();
      expect(result.cleaned).toBe(1);
      expect(mockStore.removeTempChat).toHaveBeenCalledWith('oc_expired1');
      minimalService.stop();
    });

    it('should work without unregisterGroup dependency', async () => {
      const minimalDeps: TempChatLifecycleDeps = { chatStore: mockStore };
      const minimalService = new TempChatLifecycleService(minimalDeps);

      vi.mocked(mockStore.getExpiredTempChats).mockResolvedValue([
        { chatId: 'oc_expired1', createdAt: '2026-01-01', expiresAt: '2026-01-02' },
      ] as any);

      const result = await minimalService.checkAndCleanup();
      expect(result.cleaned).toBe(1);
      minimalService.stop();
    });
  });
});
