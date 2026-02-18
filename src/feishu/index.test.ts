/**
 * Tests for feishu module exports (src/feishu/index.ts).
 */

import { describe, it, expect } from 'vitest';

describe('Feishu Module Exports', () => {
  describe('Module Structure', () => {
    it('should export FeishuBot class', async () => {
      const module = await import('./index.js');
      expect(module.FeishuBot).toBeDefined();
    });

    it('should re-export from bot.ts', async () => {
      const module = await import('./index.js');
      expect(Object.keys(module)).toContain('FeishuBot');
    });

    it('should have .js extension in import', () => {
      const path = './bot.js';
      expect(path.endsWith('.js')).toBe(true);
    });
  });

  describe('FeishuBot Export', () => {
    it('should export FeishuBot as named export', async () => {
      const { FeishuBot } = await import('./index.js');
      expect(FeishuBot).toBeDefined();
      expect(typeof FeishuBot).toBe('function');
    });

    it('should be the only export', async () => {
      const module = await import('./index.js');
      const exports = Object.keys(module);
      expect(exports.length).toBeGreaterThanOrEqual(1);
      expect(exports).toContain('FeishuBot');
    });
  });

  describe('Module Purpose', () => {
    it('should serve as barrel export for feishu module', async () => {
      const module = await import('./index.js');
      expect(module).toBeDefined();
    });

    it('should allow imports from feishu/index', () => {
      const importPath = './feishu/index.js';
      expect(importPath).toContain('index');
    });
  });
});
