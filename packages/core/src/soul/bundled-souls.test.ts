/**
 * Tests for bundled SOUL profiles.
 *
 * Issue #1228: Verifies that bundled SOUL profiles can be resolved
 * to valid file paths and loaded via SoulLoader.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { getBundledSoulPath, DISCUSSION_SOUL_NAME } from './bundled-souls.js';
import { SoulLoader } from './loader.js';

describe('bundled-souls', () => {
  describe('getBundledSoulPath', () => {
    it('should return absolute path for discussion soul', () => {
      const soulPath = getBundledSoulPath(DISCUSSION_SOUL_NAME);
      expect(path.isAbsolute(soulPath)).toBe(true);
      expect(soulPath).toMatch(/discussion\.md$/);
    });

    it('should point to an existing file', () => {
      const soulPath = getBundledSoulPath(DISCUSSION_SOUL_NAME);
      expect(fs.existsSync(soulPath)).toBe(true);
    });

    it('should resolve to the souls directory', () => {
      const soulPath = getBundledSoulPath(DISCUSSION_SOUL_NAME);
      expect(soulPath).toContain(path.join('soul', 'souls'));
    });
  });

  describe('discussion SOUL profile', () => {
    it('should be loadable via SoulLoader', async () => {
      const soulPath = getBundledSoulPath(DISCUSSION_SOUL_NAME);
      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.content).toBeTruthy();
      expect(result!.path).toBe(soulPath);
      expect(result!.size).toBeGreaterThan(0);
    });

    it('should contain focus-keeping keywords', async () => {
      const soulPath = getBundledSoulPath(DISCUSSION_SOUL_NAME);
      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      const { content } = result!;
      expect(content).toContain('topic');
      expect(content).toContain('focus');
      expect(content).toContain('redirect');
    });

    it('should be under 4KB (concise personality definition)', async () => {
      const soulPath = getBundledSoulPath(DISCUSSION_SOUL_NAME);
      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      // A focused SOUL profile should be concise
      expect(result!.size).toBeLessThan(4 * 1024);
    });
  });
});
