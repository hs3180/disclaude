/**
 * Tests for SoulLoader - SOUL.md personality injection system.
 *
 * @module soul/loader.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SoulLoader, createSoulLoader, getDefaultSoulPath } from './loader.js';

describe('SoulLoader', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `soul-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should store the provided path', () => {
      const soulPath = path.join(tempDir, 'SOUL.md');
      const loader = new SoulLoader(soulPath);
      expect(loader.getPath()).toBe(soulPath);
    });
  });

  describe('load', () => {
    it('should load content from an existing SOUL.md file', async () => {
      const soulPath = path.join(tempDir, 'SOUL.md');
      const content = '# Core Truths\nYou are a helpful coding assistant.';
      await writeFile(soulPath, content, 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result.loaded).toBe(true);
      expect(result.path).toBe(soulPath);
      expect(result.content).toBe(content);
    });

    it('should trim whitespace from loaded content', async () => {
      const soulPath = path.join(tempDir, 'SOUL.md');
      const content = '  # Personality  \n\nYou are helpful.  \n  ';
      await writeFile(soulPath, content, 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result.loaded).toBe(true);
      expect(result.content).toBe('# Personality  \n\nYou are helpful.');
    });

    it('should return loaded=false for non-existent file', async () => {
      const soulPath = path.join(tempDir, 'nonexistent-SOUL.md');
      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result.loaded).toBe(false);
      expect(result.path).toBe(soulPath);
      expect(result.content).toBe('');
    });

    it('should return loaded=false for empty file', async () => {
      const soulPath = path.join(tempDir, 'SOUL.md');
      await writeFile(soulPath, '', 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result.loaded).toBe(false);
      expect(result.content).toBe('');
    });

    it('should return loaded=false for whitespace-only file', async () => {
      const soulPath = path.join(tempDir, 'SOUL.md');
      await writeFile(soulPath, '   \n\n  \t  \n', 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result.loaded).toBe(false);
      expect(result.content).toBe('');
    });

    it('should load multi-line SOUL.md content', async () => {
      const soulPath = path.join(tempDir, 'SOUL.md');
      const content = [
        '# SOUL.md',
        '',
        '## Core Truths',
        '- Always be honest',
        '- Provide accurate information',
        '',
        '## Boundaries',
        '- Never fabricate data',
        '- Ask when uncertain',
      ].join('\n');
      await writeFile(soulPath, content, 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result.loaded).toBe(true);
      expect(result.content).toContain('## Core Truths');
      expect(result.content).toContain('## Boundaries');
    });

    it('should load content with unicode characters', async () => {
      const soulPath = path.join(tempDir, 'SOUL.md');
      const content = '# 人格定义\n你是一个有帮助的编程助手。🤖';
      await writeFile(soulPath, content, 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result.loaded).toBe(true);
      expect(result.content).toContain('人格定义');
      expect(result.content).toContain('🤖');
    });
  });
});

describe('createSoulLoader', () => {
  it('should create a SoulLoader with explicit path', () => {
    const loader = createSoulLoader('/custom/path/SOUL.md');
    expect(loader).not.toBeNull();
    expect(loader!.getPath()).toBe('/custom/path/SOUL.md');
  });

  it('should create a SoulLoader with default path when no config provided', () => {
    const loader = createSoulLoader();
    expect(loader).not.toBeNull();
    expect(loader!.getPath()).toContain('SOUL.md');
  });

  it('should return null when no path available and HOME is not set', () => {
    const originalHome = process.env.HOME;
    const originalUserprofile = process.env.USERPROFILE;
    delete process.env.HOME;
    delete process.env.USERPROFILE;

    try {
      const loader = createSoulLoader();
      expect(loader).toBeNull();
    } finally {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserprofile;
    }
  });
});

describe('getDefaultSoulPath', () => {
  it('should return path with HOME env var', () => {
    const originalHome = process.env.HOME;
    process.env.HOME = '/test/home';

    try {
      const result = getDefaultSoulPath();
      expect(result).toBe('/test/home/.disclaude/SOUL.md');
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it('should fall back to USERPROFILE on Windows', () => {
    const originalHome = process.env.HOME;
    const originalUserprofile = process.env.USERPROFILE;
    delete process.env.HOME;
    process.env.USERPROFILE = '/windows/home';

    try {
      const result = getDefaultSoulPath();
      expect(result).toBe('/windows/home/.disclaude/SOUL.md');
    } finally {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserprofile;
    }
  });

  it('should return null when neither HOME nor USERPROFILE is set', () => {
    const originalHome = process.env.HOME;
    const originalUserprofile = process.env.USERPROFILE;
    delete process.env.HOME;
    delete process.env.USERPROFILE;

    try {
      const result = getDefaultSoulPath();
      expect(result).toBeNull();
    } finally {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserprofile;
    }
  });
});
