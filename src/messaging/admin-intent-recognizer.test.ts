/**
 * Tests for AdminIntentRecognizer.
 */

import { describe, it, expect } from 'vitest';
import {
  AdminIntent,
  recognizeAdminIntent,
  isAdminModeRequest,
} from './admin-intent-recognizer.js';

describe('AdminIntentRecognizer', () => {
  describe('recognizeAdminIntent', () => {
    describe('enable intent (Chinese)', () => {
      it('should recognize "接收所有消息"', () => {
        const result = recognizeAdminIntent('我要接收所有消息');
        expect(result.intent).toBe(AdminIntent.ENABLE);
        expect(result.matchedKeywords).toContain('接收所有消息');
      });

      it('should recognize "开启调试模式"', () => {
        const result = recognizeAdminIntent('请帮我开启调试模式');
        expect(result.intent).toBe(AdminIntent.ENABLE);
        expect(result.matchedKeywords).toContain('开启调试模式');
      });

      it('should recognize "开启管理员模式"', () => {
        const result = recognizeAdminIntent('我要开启管理员模式');
        expect(result.intent).toBe(AdminIntent.ENABLE);
      });

      it('should recognize "我要看日志"', () => {
        const result = recognizeAdminIntent('我要看日志');
        expect(result.intent).toBe(AdminIntent.ENABLE);
      });
    });

    describe('enable intent (English)', () => {
      it('should recognize "receive all messages"', () => {
        const result = recognizeAdminIntent('I want to receive all messages');
        expect(result.intent).toBe(AdminIntent.ENABLE);
        expect(result.matchedKeywords).toContain('receive all messages');
      });

      it('should recognize "enable admin mode"', () => {
        const result = recognizeAdminIntent('Please enable admin mode');
        expect(result.intent).toBe(AdminIntent.ENABLE);
      });

      it('should recognize "debug mode on"', () => {
        const result = recognizeAdminIntent('turn debug mode on');
        expect(result.intent).toBe(AdminIntent.ENABLE);
      });

      it('should be case-insensitive', () => {
        const result = recognizeAdminIntent('ENABLE ADMIN MODE');
        expect(result.intent).toBe(AdminIntent.ENABLE);
      });
    });

    describe('disable intent (Chinese)', () => {
      it('should recognize "停止接收操作消息"', () => {
        const result = recognizeAdminIntent('我要停止接收操作消息');
        expect(result.intent).toBe(AdminIntent.DISABLE);
        expect(result.matchedKeywords).toContain('停止接收操作消息');
      });

      it('should recognize "关闭调试模式"', () => {
        const result = recognizeAdminIntent('请关闭调试模式');
        expect(result.intent).toBe(AdminIntent.DISABLE);
      });

      it('should recognize "不需要日志"', () => {
        const result = recognizeAdminIntent('我不需要日志了');
        expect(result.intent).toBe(AdminIntent.DISABLE);
      });
    });

    describe('disable intent (English)', () => {
      it('should recognize "stop receiving messages"', () => {
        const result = recognizeAdminIntent('I want to stop receiving messages');
        expect(result.intent).toBe(AdminIntent.DISABLE);
      });

      it('should recognize "disable admin mode"', () => {
        const result = recognizeAdminIntent('Please disable admin mode');
        expect(result.intent).toBe(AdminIntent.DISABLE);
      });

      it('should recognize "no more logs"', () => {
        const result = recognizeAdminIntent('No more logs please');
        expect(result.intent).toBe(AdminIntent.DISABLE);
      });
    });

    describe('no intent', () => {
      it('should return NONE for unrelated messages', () => {
        const result = recognizeAdminIntent('今天天气怎么样');
        expect(result.intent).toBe(AdminIntent.NONE);
      });

      it('should return NONE for empty message', () => {
        const result = recognizeAdminIntent('');
        expect(result.intent).toBe(AdminIntent.NONE);
      });

      it('should return NONE for conflicting keywords', () => {
        // Message contains both enable and disable keywords
        const result = recognizeAdminIntent('开启调试模式然后关闭调试模式');
        expect(result.intent).toBe(AdminIntent.NONE);
      });
    });

    describe('confidence', () => {
      it('should have higher confidence for multiple matches', () => {
        const result1 = recognizeAdminIntent('开启调试模式');
        const result2 = recognizeAdminIntent('我要开启调试模式并接收所有消息');

        expect(result2.confidence).toBeGreaterThan(result1.confidence);
      });

      it('should cap confidence at 1.0', () => {
        const result = recognizeAdminIntent(
          '我要接收所有消息开启调试模式开启管理员模式显示详细信息'
        );
        expect(result.confidence).toBeLessThanOrEqual(1.0);
      });
    });
  });

  describe('isAdminModeRequest', () => {
    it('should return true for enable requests with high confidence', () => {
      expect(isAdminModeRequest('我要接收所有消息')).toBe(true);
    });

    it('should return true for disable requests with high confidence', () => {
      expect(isAdminModeRequest('停止接收操作消息')).toBe(true);
    });

    it('should return false for unrelated messages', () => {
      expect(isAdminModeRequest('帮我写代码')).toBe(false);
    });

    it('should return false for low confidence matches', () => {
      // Single match might have low confidence
      expect(isAdminModeRequest('调试')).toBe(false);
    });
  });
});
