/**
 * Tests for PatternStore.
 *
 * @see Issue #357 - Intelligent Scheduled Task Recommendation System
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { PatternStore } from './pattern-store.js';
import type { ChatAnalysisResult, DetectedPattern } from './types.js';

describe('PatternStore', () => {
  let store: PatternStore;
  let testDir: string;

  beforeEach(async () => {
    // Create a unique test directory
    testDir = path.join('/tmp', `pattern-store-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    store = new PatternStore({ dataDir: testDir });
    await store.init();
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('init', () => {
    it('should create necessary directories', async () => {
      const patternsDir = path.join(testDir, 'patterns');
      const stat = await fs.stat(patternsDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should be idempotent', async () => {
      // Call init multiple times
      await store.init();
      await store.init();
      // Should not throw
    });
  });

  describe('saveChatPatterns', () => {
    it('should save patterns for a chat', async () => {
      const chatId = 'oc_test_chat';
      const result: ChatAnalysisResult = {
        chatId,
        patterns: [
          {
            id: 'pattern-1',
            taskType: 'issue-check',
            occurrences: 5,
            suggestedSchedule: '0 9 * * *',
            scheduleDescription: '每天 09:00',
            confidence: 0.8,
            samplePrompts: ['check issues'],
            chatId,
            firstDetectedAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
            recommendedPrompt: 'Check issues',
            status: 'pending',
          },
        ],
        analyzedAt: new Date().toISOString(),
        messageCount: 10,
        timeRange: {
          start: new Date().toISOString(),
          end: new Date().toISOString(),
        },
      };

      await store.saveChatPatterns(chatId, result);

      const savedPatterns = await store.getChatPatterns(chatId);
      expect(savedPatterns).toHaveLength(1);
      expect(savedPatterns[0].taskType).toBe('issue-check');
    });

    it('should merge patterns with existing ones', async () => {
      const chatId = 'oc_test_merge';
      const pattern1: DetectedPattern = {
        id: 'pattern-1',
        taskType: 'issue-check',
        occurrences: 3,
        suggestedSchedule: '0 9 * * *',
        scheduleDescription: '每天 09:00',
        confidence: 0.7,
        samplePrompts: ['check issues'],
        chatId,
        firstDetectedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        recommendedPrompt: 'Check issues',
        status: 'pending',
      };

      // Save first pattern
      await store.saveChatPatterns(chatId, {
        chatId,
        patterns: [pattern1],
        analyzedAt: new Date().toISOString(),
        messageCount: 5,
        timeRange: {
          start: new Date().toISOString(),
          end: new Date().toISOString(),
        },
      });

      // Save another pattern with same taskType
      const pattern2: DetectedPattern = {
        id: 'pattern-2',
        taskType: 'issue-check',
        occurrences: 2,
        suggestedSchedule: '0 10 * * *',
        scheduleDescription: '每天 10:00',
        confidence: 0.8,
        samplePrompts: ['check github issues'],
        chatId,
        firstDetectedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        recommendedPrompt: 'Check GitHub issues',
        status: 'pending',
      };

      await store.saveChatPatterns(chatId, {
        chatId,
        patterns: [pattern2],
        analyzedAt: new Date().toISOString(),
        messageCount: 3,
        timeRange: {
          start: new Date().toISOString(),
          end: new Date().toISOString(),
        },
      });

      const savedPatterns = await store.getChatPatterns(chatId);
      // Should merge patterns with same taskType
      expect(savedPatterns).toHaveLength(1);
      expect(savedPatterns[0].occurrences).toBe(5); // 3 + 2
    });
  });

  describe('getChatPatterns', () => {
    it('should return empty array for non-existent chat', async () => {
      const patterns = await store.getChatPatterns('non_existent_chat');
      expect(patterns).toEqual([]);
    });
  });

  describe('getAllPatterns', () => {
    it('should return patterns from all chats', async () => {
      const chatId1 = 'oc_chat1';
      const chatId2 = 'oc_chat2';

      const pattern1: DetectedPattern = {
        id: 'pattern-1',
        taskType: 'issue-check',
        occurrences: 3,
        suggestedSchedule: '0 9 * * *',
        scheduleDescription: '每天 09:00',
        confidence: 0.7,
        samplePrompts: ['check issues'],
        chatId: chatId1,
        firstDetectedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        recommendedPrompt: 'Check issues',
        status: 'pending',
      };

      const pattern2: DetectedPattern = {
        id: 'pattern-2',
        taskType: 'report-generation',
        occurrences: 4,
        suggestedSchedule: '0 10 * * *',
        scheduleDescription: '每天 10:00',
        confidence: 0.8,
        samplePrompts: ['generate report'],
        chatId: chatId2,
        firstDetectedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        recommendedPrompt: 'Generate report',
        status: 'pending',
      };

      await store.saveChatPatterns(chatId1, {
        chatId: chatId1,
        patterns: [pattern1],
        analyzedAt: new Date().toISOString(),
        messageCount: 5,
        timeRange: {
          start: new Date().toISOString(),
          end: new Date().toISOString(),
        },
      });

      await store.saveChatPatterns(chatId2, {
        chatId: chatId2,
        patterns: [pattern2],
        analyzedAt: new Date().toISOString(),
        messageCount: 6,
        timeRange: {
          start: new Date().toISOString(),
          end: new Date().toISOString(),
        },
      });

      const allPatterns = await store.getAllPatterns();
      expect(allPatterns).toHaveLength(2);
    });
  });

  describe('getPatternsByStatus', () => {
    it('should filter patterns by status', async () => {
      const chatId = 'oc_test_status';
      const patterns: DetectedPattern[] = [
        {
          id: 'pattern-1',
          taskType: 'issue-check',
          occurrences: 3,
          suggestedSchedule: '0 9 * * *',
          scheduleDescription: '每天 09:00',
          confidence: 0.7,
          samplePrompts: ['check issues'],
          chatId,
          firstDetectedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          recommendedPrompt: 'Check issues',
          status: 'pending',
        },
        {
          id: 'pattern-2',
          taskType: 'report-generation',
          occurrences: 4,
          suggestedSchedule: '0 10 * * *',
          scheduleDescription: '每天 10:00',
          confidence: 0.8,
          samplePrompts: ['generate report'],
          chatId,
          firstDetectedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          recommendedPrompt: 'Generate report',
          status: 'confirmed',
        },
      ];

      await store.saveChatPatterns(chatId, {
        chatId,
        patterns,
        analyzedAt: new Date().toISOString(),
        messageCount: 10,
        timeRange: {
          start: new Date().toISOString(),
          end: new Date().toISOString(),
        },
      });

      const pendingPatterns = await store.getPatternsByStatus('pending');
      expect(pendingPatterns).toHaveLength(1);
      expect(pendingPatterns[0].status).toBe('pending');

      const confirmedPatterns = await store.getPatternsByStatus('confirmed');
      expect(confirmedPatterns).toHaveLength(1);
      expect(confirmedPatterns[0].status).toBe('confirmed');
    });
  });

  describe('updatePatternStatus', () => {
    it('should update pattern status', async () => {
      const chatId = 'oc_test_update';
      const pattern: DetectedPattern = {
        id: 'pattern-1',
        taskType: 'issue-check',
        occurrences: 3,
        suggestedSchedule: '0 9 * * *',
        scheduleDescription: '每天 09:00',
        confidence: 0.7,
        samplePrompts: ['check issues'],
        chatId,
        firstDetectedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        recommendedPrompt: 'Check issues',
        status: 'pending',
      };

      await store.saveChatPatterns(chatId, {
        chatId,
        patterns: [pattern],
        analyzedAt: new Date().toISOString(),
        messageCount: 5,
        timeRange: {
          start: new Date().toISOString(),
          end: new Date().toISOString(),
        },
      });

      await store.updatePatternStatus('pattern-1', 'confirmed');

      const patterns = await store.getChatPatterns(chatId);
      expect(patterns[0].status).toBe('confirmed');
    });
  });

  describe('saveLatestAnalysis', () => {
    it('should save and retrieve latest analysis', async () => {
      const result = {
        chats: [],
        analyzedAt: new Date().toISOString(),
        config: {
          analysisInterval: '0 3 * * *',
          lookbackDays: 30,
          minOccurrences: 3,
          minConfidence: 0.7,
          enabled: true,
        },
        summary: {
          totalChats: 0,
          totalPatterns: 0,
          highConfidencePatterns: 0,
        },
      };

      await store.saveLatestAnalysis(result);

      const latest = await store.getLatestAnalysis();
      expect(latest).toBeDefined();
      expect(latest?.summary.totalChats).toBe(0);
    });
  });

  describe('deleteChatPatterns', () => {
    it('should delete patterns for a chat', async () => {
      const chatId = 'oc_test_delete';
      const pattern: DetectedPattern = {
        id: 'pattern-1',
        taskType: 'issue-check',
        occurrences: 3,
        suggestedSchedule: '0 9 * * *',
        scheduleDescription: '每天 09:00',
        confidence: 0.7,
        samplePrompts: ['check issues'],
        chatId,
        firstDetectedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        recommendedPrompt: 'Check issues',
        status: 'pending',
      };

      await store.saveChatPatterns(chatId, {
        chatId,
        patterns: [pattern],
        analyzedAt: new Date().toISOString(),
        messageCount: 5,
        timeRange: {
          start: new Date().toISOString(),
          end: new Date().toISOString(),
        },
      });

      await store.deleteChatPatterns(chatId);

      const patterns = await store.getChatPatterns(chatId);
      expect(patterns).toEqual([]);
    });
  });

  describe('clearAll', () => {
    it('should clear all patterns', async () => {
      const chatId = 'oc_test_clear';
      const pattern: DetectedPattern = {
        id: 'pattern-1',
        taskType: 'issue-check',
        occurrences: 3,
        suggestedSchedule: '0 9 * * *',
        scheduleDescription: '每天 09:00',
        confidence: 0.7,
        samplePrompts: ['check issues'],
        chatId,
        firstDetectedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        recommendedPrompt: 'Check issues',
        status: 'pending',
      };

      await store.saveChatPatterns(chatId, {
        chatId,
        patterns: [pattern],
        analyzedAt: new Date().toISOString(),
        messageCount: 5,
        timeRange: {
          start: new Date().toISOString(),
          end: new Date().toISOString(),
        },
      });

      await store.clearAll();

      const allPatterns = await store.getAllPatterns();
      expect(allPatterns).toEqual([]);
    });
  });
});
