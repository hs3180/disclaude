/**
 * SoulLoader unit tests.
 *
 * @module soul/loader.test
 * @see Issue #1228 - Discussion focus keeping via SOUL.md
 * @see Issue #1315 - SOUL.md personality definition system
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import {
  loadSoulFile,
  loadSoul,
  expandTilde,
  formatSoulAsSystemPrompt,
} from './loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('SoulLoader', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `soul-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('expandTilde', () => {
    it('should expand ~/ to home directory', () => {
      const result = expandTilde('~/test/SOUL.md');
      expect(result).not.toContain('~');
      expect(result).toContain('test');
      expect(result).toContain('SOUL.md');
    });

    it('should not modify absolute paths', () => {
      const absolutePath = '/tmp/test/SOUL.md';
      expect(expandTilde(absolutePath)).toBe(absolutePath);
    });

    it('should resolve relative paths', () => {
      const result = expandTilde('test/SOUL.md');
      expect(result).toContain('test');
    });
  });

  describe('loadSoulFile', () => {
    it('should return not found for non-existent file', () => {
      const result = loadSoulFile(join(testDir, 'nonexistent.md'));
      expect(result.found).toBe(false);
      expect(result.content).toBe('');
      expect(result.sizeBytes).toBe(0);
    });

    it('should load an existing SOUL.md file', () => {
      const filePath = join(testDir, 'SOUL.md');
      const content = '# Test Soul\n\nBe helpful.';
      writeFileSync(filePath, content, 'utf-8');

      const result = loadSoulFile(filePath);
      expect(result.found).toBe(true);
      expect(result.content).toBe(content);
      expect(result.sizeBytes).toBeGreaterThan(0);
      expect(result.sourcePath).toBeDefined();
    });

    it('should trim leading/trailing whitespace from content', () => {
      const filePath = join(testDir, 'SOUL.md');
      const content = '  # Test Soul\n\nBe helpful.  \n  ';
      writeFileSync(filePath, content, 'utf-8');

      const result = loadSoulFile(filePath);
      expect(result.content).toBe('# Test Soul\n\nBe helpful.');
    });

    it('should handle empty file', () => {
      const filePath = join(testDir, 'SOUL.md');
      writeFileSync(filePath, '', 'utf-8');

      const result = loadSoulFile(filePath);
      expect(result.found).toBe(true);
      expect(result.content).toBe('');
    });

    it('should handle files larger than 32KB without crashing', () => {
      const filePath = join(testDir, 'large-soul.md');
      // Create a file slightly over 32KB
      const largeContent = 'X'.repeat(33 * 1024);
      writeFileSync(filePath, largeContent, 'utf-8');

      const result = loadSoulFile(filePath);
      // Should still load (with warning) but not crash
      expect(result.found).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
    });
  });

  describe('loadSoul', () => {
    it('should return empty when no files exist', () => {
      const result = loadSoul({
        explicitPath: join(testDir, 'nonexistent.md'),
        configPath: join(testDir, 'nonexistent-config.md'),
        workspaceDir: testDir,
      });
      expect(result.found).toBe(false);
      expect(result.content).toBe('');
    });

    it('should prioritize explicit path over config path', () => {
      const explicitPath = join(testDir, 'explicit.md');
      const configPath = join(testDir, 'config.md');
      writeFileSync(explicitPath, '# Explicit Soul', 'utf-8');
      writeFileSync(configPath, '# Config Soul', 'utf-8');

      const result = loadSoul({
        explicitPath,
        configPath,
      });
      expect(result.found).toBe(true);
      expect(result.content).toBe('# Explicit Soul');
    });

    it('should fallback to config path when explicit not found', () => {
      const configPath = join(testDir, 'config.md');
      writeFileSync(configPath, '# Config Soul', 'utf-8');

      const result = loadSoul({
        explicitPath: join(testDir, 'nonexistent.md'),
        configPath,
      });
      expect(result.found).toBe(true);
      expect(result.content).toBe('# Config Soul');
    });

    it('should fallback to workspace SOUL.md', () => {
      const workspaceSoulPath = join(testDir, 'SOUL.md');
      writeFileSync(workspaceSoulPath, '# Workspace Soul', 'utf-8');

      const result = loadSoul({
        workspaceDir: testDir,
      });
      expect(result.found).toBe(true);
      expect(result.content).toBe('# Workspace Soul');
    });

    it('should work with empty options', () => {
      const result = loadSoul();
      expect(result.found).toBe(false);
    });
  });

  describe('formatSoulAsSystemPrompt', () => {
    it('should wrap content in soul-profile tags', () => {
      const content = '# Discussion SOUL\n\nStay on topic.';
      const result = formatSoulAsSystemPrompt(content);
      expect(result).toBe('<soul-profile>\n# Discussion SOUL\n\nStay on topic.\n</soul-profile>');
    });

    it('should return undefined for empty string', () => {
      expect(formatSoulAsSystemPrompt('')).toBeUndefined();
    });

    it('should return undefined for whitespace-only string', () => {
      expect(formatSoulAsSystemPrompt('   \n  \t  ')).toBeUndefined();
    });

    it('should return undefined for undefined input', () => {
      expect(formatSoulAsSystemPrompt(undefined as unknown as string)).toBeUndefined();
    });

    it('should trim content before wrapping', () => {
      const content = '  # Soul  \n  ';
      const result = formatSoulAsSystemPrompt(content);
      expect(result).toBe('<soul-profile>\n# Soul\n</soul-profile>');
    });
  });

  describe('integration: load actual discussion soul file', () => {
    it('should load the project discussion soul file', () => {
      // The discussion soul file should exist at souls/discussion.md
      const discussionSoulPath = join(__dirname, '../../../../../../souls/discussion.md');

      if (existsSync(discussionSoulPath)) {
        const result = loadSoulFile(discussionSoulPath);
        expect(result.found).toBe(true);
        expect(result.content).toContain('Discussion SOUL');
        expect(result.content).toContain('Stay on topic');
      } else {
        // Skip if the file doesn't exist (e.g., in test environment)
        console.log('Skipping: souls/discussion.md not found');
      }
    });
  });
});
