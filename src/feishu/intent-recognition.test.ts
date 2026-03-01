/**
 * Tests for IntentRecognition.
 */

import { describe, it, expect } from 'vitest';
import {
  recognizeIntent,
  isAdminModeIntent,
  isEnableAdminIntent,
  isDisableAdminIntent,
  Intent,
} from './intent-recognition.js';

describe('IntentRecognition', () => {
  describe('recognizeIntent', () => {
    describe('enable admin intent', () => {
      it('should recognize "开启管理员"', () => {
        const result = recognizeIntent('开启管理员');
        expect(result.intent).toBe(Intent.ENABLE_ADMIN);
        expect(result.confidence).toBe(0.9);
      });

      it('should recognize "启用管理员模式"', () => {
        const result = recognizeIntent('启用管理员模式');
        expect(result.intent).toBe(Intent.ENABLE_ADMIN);
      });

      it('should recognize "enable admin mode"', () => {
        const result = recognizeIntent('enable admin mode');
        expect(result.intent).toBe(Intent.ENABLE_ADMIN);
      });

      it('should recognize "开启管理员模式"', () => {
        const result = recognizeIntent('开启管理员模式');
        expect(result.intent).toBe(Intent.ENABLE_ADMIN);
      });
    });

    describe('disable admin intent', () => {
      it('should recognize "关闭管理员"', () => {
        const result = recognizeIntent('关闭管理员');
        expect(result.intent).toBe(Intent.DISABLE_ADMIN);
        expect(result.confidence).toBe(0.9);
      });

      it('should recognize "退出管理员模式"', () => {
        const result = recognizeIntent('退出管理员模式');
        expect(result.intent).toBe(Intent.DISABLE_ADMIN);
      });

      it('should recognize "disable admin"', () => {
        const result = recognizeIntent('disable admin');
        expect(result.intent).toBe(Intent.DISABLE_ADMIN);
      });

      it('should recognize "exit admin mode"', () => {
        const result = recognizeIntent('exit admin mode');
        expect(result.intent).toBe(Intent.DISABLE_ADMIN);
      });
    });

    describe('question intent', () => {
      it('should recognize question with "?"', () => {
        const result = recognizeIntent('What is this?');
        expect(result.intent).toBe(Intent.QUESTION);
      });

      it('should recognize question with "？"', () => {
        const result = recognizeIntent('这是什么？');
        expect(result.intent).toBe(Intent.QUESTION);
      });

      it('should recognize "how to" questions', () => {
        const result = recognizeIntent('how to enable admin mode');
        expect(result.intent).toBe(Intent.QUESTION);
      });

      it('should recognize "如何" questions', () => {
        const result = recognizeIntent('如何开启管理员');
        expect(result.intent).toBe(Intent.QUESTION);
      });
    });

    describe('command intent', () => {
      it('should recognize "please" commands', () => {
        const result = recognizeIntent('please help me');
        expect(result.intent).toBe(Intent.COMMAND);
      });

      it('should recognize "请" commands', () => {
        const result = recognizeIntent('请帮我');
        expect(result.intent).toBe(Intent.COMMAND);
      });

      it('should recognize "run" commands', () => {
        const result = recognizeIntent('run the test');
        expect(result.intent).toBe(Intent.COMMAND);
      });
    });

    describe('unknown intent', () => {
      it('should return UNKNOWN for empty string', () => {
        const result = recognizeIntent('');
        expect(result.intent).toBe(Intent.UNKNOWN);
        expect(result.confidence).toBe(1.0);
      });

      it('should return UNKNOWN for random text', () => {
        const result = recognizeIntent('hello world');
        expect(result.intent).toBe(Intent.UNKNOWN);
      });

      it('should return UNKNOWN for whitespace', () => {
        const result = recognizeIntent('   ');
        expect(result.intent).toBe(Intent.UNKNOWN);
      });
    });
  });

  describe('isAdminModeIntent', () => {
    it('should return true for enable admin intent', () => {
      expect(isAdminModeIntent('开启管理员')).toBe(true);
    });

    it('should return true for disable admin intent', () => {
      expect(isAdminModeIntent('关闭管理员')).toBe(true);
    });

    it('should return false for other intents', () => {
      expect(isAdminModeIntent('hello world')).toBe(false);
    });
  });

  describe('isEnableAdminIntent', () => {
    it('should return true for enable admin intent', () => {
      expect(isEnableAdminIntent('开启管理员')).toBe(true);
      expect(isEnableAdminIntent('enable admin mode')).toBe(true);
    });

    it('should return false for disable admin intent', () => {
      expect(isEnableAdminIntent('关闭管理员')).toBe(false);
    });

    it('should return false for other intents', () => {
      expect(isEnableAdminIntent('hello world')).toBe(false);
    });
  });

  describe('isDisableAdminIntent', () => {
    it('should return true for disable admin intent', () => {
      expect(isDisableAdminIntent('关闭管理员')).toBe(true);
      expect(isDisableAdminIntent('disable admin mode')).toBe(true);
    });

    it('should return false for enable admin intent', () => {
      expect(isDisableAdminIntent('开启管理员')).toBe(false);
    });

    it('should return false for other intents', () => {
      expect(isDisableAdminIntent('hello world')).toBe(false);
    });
  });
});
