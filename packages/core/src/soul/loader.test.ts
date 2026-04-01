/**
 * Tests for SoulLoader - SOUL.md personality file loader.
 *
 * Issue #1315: Verifies file loading, tilde expansion, size limits,
 * and graceful degradation behavior.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SoulLoader, SOUL_MAX_SIZE_BYTES } from './loader.js';

describe('SoulLoader', () => {
  let tempDir: string;
  let cleanupPaths: string[];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soul-loader-test-'));
    cleanupPaths = [];
  });

  afterEach(async () => {
    for (const p of cleanupPaths) {
      await fs.unlink(p).catch(() => {});
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeFile(name: string, _content: string): string {
    const filePath = path.join(tempDir, name);
    cleanupPaths.push(filePath);
    return filePath;
  }

  async function writeFile(filePath: string, content: string): Promise<void> {
    await fs.writeFile(filePath, content, 'utf-8');
  }

  // =========================================================================
  // resolvePath
  // =========================================================================

  describe('resolvePath', () => {
    it('should expand tilde to home directory', () => {
      const resolved = SoulLoader.resolvePath('~/test/SOUL.md');
      expect(resolved).toBe(path.join(os.homedir(), 'test/SOUL.md'));
    });

    it('should handle bare tilde', () => {
      const resolved = SoulLoader.resolvePath('~');
      expect(resolved).toBe(os.homedir());
    });

    it('should not modify non-tilde paths', () => {
      const absolute = '/etc/disclaude/SOUL.md';
      expect(SoulLoader.resolvePath(absolute)).toBe(path.resolve(absolute));
    });

    it('should resolve relative paths against cwd', () => {
      const relative = 'config/SOUL.md';
      expect(SoulLoader.resolvePath(relative)).toBe(path.resolve(relative));
    });
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('should resolve tilde path at construction', () => {
      const loader = new SoulLoader('~/SOUL.md');
      expect(loader.getResolvedPath()).toBe(path.join(os.homedir(), 'SOUL.md'));
    });

    it('should store absolute path', () => {
      const loader = new SoulLoader('/etc/SOUL.md');
      expect(loader.getResolvedPath()).toBe(path.resolve('/etc/SOUL.md'));
    });
  });

  // =========================================================================
  // load
  // =========================================================================

  describe('load', () => {
    it('should load a valid SOUL.md file', async () => {
      const filePath = makeFile('SOUL.md', '');
      const content = '# Core Truths\nYou are helpful.';
      await writeFile(filePath, content);

      const loader = new SoulLoader(filePath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.content).toBe(content);
      expect(result!.sourcePath).toBe(path.resolve(filePath));
      expect(result!.sizeBytes).toBe(Buffer.byteLength(content, 'utf-8'));
    });

    it('should trim trailing whitespace but preserve content', async () => {
      const filePath = makeFile('SOUL.md', '');
      const content = '# Core Truths\n  \n  ';
      await writeFile(filePath, content);

      const loader = new SoulLoader(filePath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.content).toBe('# Core Truths');
    });

    it('should return null for non-existent file', async () => {
      const loader = new SoulLoader('/nonexistent/SOUL.md');
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should return null for empty file', async () => {
      const filePath = makeFile('empty.md', '');
      await writeFile(filePath, '');

      const loader = new SoulLoader(filePath);
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should return null for whitespace-only file', async () => {
      const filePath = makeFile('whitespace.md', '');
      await writeFile(filePath, '   \n\n   ');

      const loader = new SoulLoader(filePath);
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should return null for file exceeding size limit', async () => {
      const filePath = makeFile('large.md', '');
      // Create content larger than 32KB
      const largeContent = 'x'.repeat(SOUL_MAX_SIZE_BYTES + 1);
      await writeFile(filePath, largeContent);

      const loader = new SoulLoader(filePath);
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should load file exactly at size limit', async () => {
      const filePath = makeFile('exact-limit.md', '');
      const content = 'x'.repeat(SOUL_MAX_SIZE_BYTES);
      await writeFile(filePath, content);

      const loader = new SoulLoader(filePath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.sizeBytes).toBe(SOUL_MAX_SIZE_BYTES);
    });

    it('should handle Unicode content correctly (bytes vs characters)', async () => {
      const filePath = makeFile('unicode.md', '');
      // Chinese characters are 3 bytes each in UTF-8
      const unicodeContent = '你好世界，这是一个测试。'.repeat(100); // ~300 bytes
      await writeFile(filePath, unicodeContent);

      const loader = new SoulLoader(filePath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.content).toBe(unicodeContent.trimEnd());
      // sizeBytes should be actual byte count, not character count
      expect(result!.sizeBytes).toBe(Buffer.byteLength(unicodeContent, 'utf-8'));
    });

    it('should handle emoji content correctly', async () => {
      const filePath = makeFile('emoji.md', '');
      const emojiContent = '🤖🧠💡'.repeat(100); // Each emoji is 4 bytes
      await writeFile(filePath, emojiContent);

      const loader = new SoulLoader(filePath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.content).toBe(emojiContent.trimEnd());
    });

    it('should load file with complex markdown content', async () => {
      const filePath = makeFile('complex.md', '');
      const complexContent = `# Core Truths
- Topic anchoring
- Genuine helpfulness

## Behavioral Guidelines
1. First message should be welcoming
2. Stay on topic

### Boundaries
- No harmful content
- No impersonation

\`\`\`
code block here
\`\`\`

> A wise quote

---

Last section with **bold** and *italic*.`;
      await writeFile(filePath, complexContent);

      const loader = new SoulLoader(filePath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.content).toContain('# Core Truths');
      expect(result!.content).toContain('Last section');
      expect(result!.content).toContain('**bold**');
    });

    it('should handle multiple consecutive load calls independently', async () => {
      const filePath = makeFile('reload.md', '');
      await writeFile(filePath, 'Version 1');

      const loader = new SoulLoader(filePath);

      const result1 = await loader.load();
      expect(result1!.content).toBe('Version 1');

      // Update file
      await writeFile(filePath, 'Version 2');

      const result2 = await loader.load();
      expect(result2!.content).toBe('Version 2');
    });
  });
});
