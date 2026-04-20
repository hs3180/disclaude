/**
 * Tests for start-discussion skill SKILL.md validation.
 *
 * Ensures the SKILL.md:
 * - Has valid YAML frontmatter with required fields
 * - References existing chat infrastructure scripts
 * - Uses correct MCP tools (not banned patterns)
 * - Follows the consumer pattern for the chat lifecycle
 */

import { describe, it, expect } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_DIR, 'SKILL.md');

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error('Invalid SKILL.md: missing YAML frontmatter');
  }

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    frontmatter[key] = value;
  }

  return { frontmatter, body: match[2] };
}

describe('start-discussion skill', () => {
  describe('SKILL.md format', () => {
    it('should have a valid SKILL.md file', async () => {
      const content = await readFile(SKILL_MD, 'utf-8');
      expect(content.length).toBeGreaterThan(100);
    });

    it('should have YAML frontmatter with required fields', async () => {
      const content = await readFile(SKILL_MD, 'utf-8');
      const { frontmatter } = parseFrontmatter(content);

      expect(frontmatter['name']).toBeDefined();
      expect(frontmatter['name']).toBe('start-discussion');
      expect(frontmatter['description']).toBeDefined();
      expect(frontmatter['description'].length).toBeGreaterThan(10);
      expect(frontmatter['allowed-tools']).toBeDefined();
    });

    it('should include required tools in allowed-tools', async () => {
      const content = await readFile(SKILL_MD, 'utf-8');
      const { frontmatter } = parseFrontmatter(content);
      const tools = frontmatter['allowed-tools'] ?? '';

      // Must include Bash for running chat scripts
      expect(tools).toContain('Bash');
      // Must include send_text or send_interactive for sending messages
      expect(tools.includes('send_text') || tools.includes('send_interactive')).toBe(true);
      // Must include Read for polling chat files
      expect(tools).toContain('Read');
    });

    it('should reference existing chat infrastructure scripts', async () => {
      const content = await readFile(SKILL_MD, 'utf-8');

      // Must reference the chat skill's create script
      expect(content).toContain('skills/chat/create.ts');
      // Must reference the chat skill's query script
      expect(content).toContain('skills/chat/query.ts');
    });

    it('should reference correct MCP tools', async () => {
      const content = await readFile(SKILL_MD, 'utf-8');

      // Should reference send_text for text messages
      expect(content).toContain('send_text');
      // Should reference send_interactive for card messages
      expect(content).toContain('send_interactive');
    });

    it('should reference the chats-activation schedule', async () => {
      const content = await readFile(SKILL_MD, 'utf-8');
      expect(content).toContain('chats-activation');
    });

    it('should reference the chat-timeout skill', async () => {
      const content = await readFile(SKILL_MD, 'utf-8');
      expect(content).toContain('chat-timeout');
    });
  });

  describe('integration with chat skill', () => {
    it('should reference chat scripts that actually exist', async () => {
      // Check referenced scripts exist
      const scripts = ['skills/chat/create.ts', 'skills/chat/query.ts'];
      for (const script of scripts) {
        const scriptPath = resolve(SKILL_DIR, '..', '..', script);
        await stat(scriptPath); // Will throw if file doesn't exist
      }
    });

    it('should use the correct CHAT_ID format (discuss- prefix)', async () => {
      const content = await readFile(SKILL_MD, 'utf-8');
      expect(content).toMatch(/discuss-\{.*\}/);
    });

    it('should document the non-blocking behavior', async () => {
      const content = await readFile(SKILL_MD, 'utf-8');
      // Must explicitly mention non-blocking behavior
      expect(content.toLowerCase()).toContain('non-blocking');
    });

    it('should document expiry handling', async () => {
      const content = await readFile(SKILL_MD, 'utf-8');
      // Must mention expiresAt
      expect(content).toContain('expiresAt');
      // Must mention the UTC Z-suffix format
      expect(content).toMatch(/UTC/i);
    });
  });

  describe('banned patterns (from rejected PRs)', () => {
    it('should NOT reference creating new MCP tools', async () => {
      const content = await readFile(SKILL_MD, 'utf-8');

      // Should not suggest creating new MCP tools
      // This was the reason PR #1531 was rejected (composite MCP violates SRP)
      expect(content).not.toContain('create a new MCP tool');
      expect(content).not.toContain('new MCP tool');
    });

    it('should NOT call lark-cli directly for group creation', async () => {
      const content = await readFile(SKILL_MD, 'utf-8');

      // Should not instruct the Agent to call lark-cli directly
      // Group creation is handled by the chats-activation schedule
      const lines = content.split('\n');
      for (const line of lines) {
        // Skip lines that are descriptions or documentation
        if (line.trim().startsWith('|') || line.trim().startsWith('#') || line.trim().startsWith('-')) continue;
        if (line.trim().startsWith('<!--')) continue;
        if (line.includes('chats-activation') || line.includes('chat-timeout')) continue;
        if (line.includes('schedule') || line.includes('Schedule')) continue;
        // Allow mentioning lark-cli in lifecycle management table
        if (line.includes('Lifecycle Management')) continue;
        expect(line).not.toContain('lark-cli im +chat-create');
      }
    });
  });

  describe('DO NOT section', () => {
    it('should have a DO NOT section with clear rules', async () => {
      const content = await readFile(SKILL_MD, 'utf-8');
      expect(content).toContain('## DO NOT');
    });

    it('should warn against blocking for response', async () => {
      const content = await readFile(SKILL_MD, 'utf-8');
      expect(content).toMatch(/block.*wait.*response/i);
    });
  });
});
