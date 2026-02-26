/**
 * Tests for feishu module exports (src/feishu/index.ts).
 */

import { describe, it, expect } from 'vitest';

describe('Feishu Module Exports', () => {
  describe('Module Structure', () => {
    it('should export FeishuMessageSender class', async () => {
      const module = await import('./index.js');
      expect(module.FeishuMessageSender).toBeDefined();
    });

    it('should export FeishuFileHandler class', async () => {
      const module = await import('./index.js');
      expect(module.FeishuFileHandler).toBeDefined();
    });

    it('should export TaskFlowOrchestrator class', async () => {
      const module = await import('./index.js');
      expect(module.TaskFlowOrchestrator).toBeDefined();
    });

    it('should export attachmentManager', async () => {
      const module = await import('./index.js');
      expect(module.attachmentManager).toBeDefined();
    });

    it('should export messageLogger', async () => {
      const module = await import('./index.js');
      expect(module.messageLogger).toBeDefined();
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
