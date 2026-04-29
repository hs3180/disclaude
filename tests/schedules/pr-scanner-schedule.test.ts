/**
 * tests/schedules/pr-scanner-schedule.test.ts
 *
 * Validates the PR Scanner SCHEDULE.md structure:
 * - Frontmatter has required fields
 * - Cron expression is valid
 * - All embedded JSON card templates are valid JSON
 * - Referenced files/skills exist
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = resolve(new URL(import.meta.url).pathname, '..', '..', '..');
const SCHEDULE_PATH = resolve(REPO_ROOT, 'schedules', 'pr-scanner', 'SCHEDULE.md');

function readSchedule(): string {
  return readFileSync(SCHEDULE_PATH, 'utf-8');
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error('No frontmatter found');
  // Simple YAML-like parsing for the flat frontmatter
  const yaml = match[1];
  const result: Record<string, unknown> = {};
  for (const line of yaml.split('\n')) {
    const kv = line.match(/^(\w+):\s*"?(.+?)"?\s*$/);
    if (kv) {
      result[kv[1]] = kv[2];
    }
  }
  return result;
}

function extractJsonBlocks(content: string): string[] {
  // Extract JSON blocks from fenced code blocks with json label
  const regex = /```json\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

describe('PR Scanner SCHEDULE.md', () => {
  const content = readSchedule();
  const frontmatter = parseFrontmatter(content);
  const jsonBlocks = extractJsonBlocks(content);

  it('has valid frontmatter with required fields', () => {
    expect(frontmatter).toHaveProperty('name');
    expect(frontmatter).toHaveProperty('cron');
    expect(frontmatter).toHaveProperty('enabled');
    expect(frontmatter).toHaveProperty('chatId');
    expect(frontmatter.name).toBe('PR Scanner');
    expect(frontmatter.enabled).toBe('true');
    expect(frontmatter.chatId).toMatch(/^oc_/);
  });

  it('has a valid cron expression', () => {
    const cron = frontmatter.cron as string;
    // Should be "*/30 * * * *" (every 30 minutes)
    expect(cron).toBe('*/30 * * * *');
    // Basic validation: should have 5 space-separated fields
    const parts = cron.split(/\s+/);
    expect(parts).toHaveLength(5);
  });

  it('has blocking mode enabled', () => {
    expect(frontmatter.blocking).toBe('true');
  });

  it('all JSON card templates are valid JSON', () => {
    expect(jsonBlocks.length).toBeGreaterThan(0);
    for (const block of jsonBlocks) {
      expect(() => JSON.parse(block), `Invalid JSON: ${block.slice(0, 80)}...`).not.toThrow();
    }
  });

  it('has PR detail card template with action buttons', () => {
    const prDetailBlock = jsonBlocks.find(b => {
      try {
        const parsed = JSON.parse(b);
        // The PR detail card has header with "PR Review" content
        return parsed.header?.title?.content?.includes('PR Review');
      } catch { return false; }
    });
    expect(prDetailBlock).toBeDefined();
    const parsed = JSON.parse(prDetailBlock!);
    const actionElement = parsed.elements.find((e: { tag: string }) => e.tag === 'action');
    expect(actionElement.actions.length).toBeGreaterThanOrEqual(3);
  });

  it('has merged notification card template', () => {
    const mergedBlock = jsonBlocks.find(b => b.includes('已合并'));
    expect(mergedBlock).toBeDefined();
    const parsed = JSON.parse(mergedBlock!);
    expect(parsed.header.template).toBe('turquoise');
  });

  it('has closed notification card template', () => {
    const closedBlock = jsonBlocks.find(b => b.includes('已关闭'));
    expect(closedBlock).toBeDefined();
    const parsed = JSON.parse(closedBlock!);
    expect(parsed.header.template).toBe('red');
  });

  it('has disband confirmation card template', () => {
    const disbandBlock = jsonBlocks.find(b => b.includes('讨论结束'));
    expect(disbandBlock).toBeDefined();
    const parsed = JSON.parse(disbandBlock!);
    expect(parsed.header.template).toBe('grey');
  });

  it('references mapping table bot-chat-mapping.json', () => {
    expect(content).toContain('bot-chat-mapping.json');
  });

  it('references create-pr-group skill', () => {
    expect(content).toContain('create-pr-group');
  });

  it('includes concurrency control (max 3)', () => {
    // Should mention the concurrency limit of 3
    const hasMax3 = content.includes('3') && (
      content.includes('并发') || content.includes('concurrent')
    );
    expect(hasMax3).toBe(true);
  });

  it('includes PR status change detection', () => {
    expect(content).toContain('MERGED');
    expect(content).toContain('CLOSED');
    expect(content).toContain('状态变更');
  });

  it('includes error handling section', () => {
    expect(content).toContain('错误处理');
  });

  it('actionPrompts have approve/deep_review/close actions', () => {
    // Find actionPrompts blocks and validate they have the expected actions
    const actionPromptBlocks = jsonBlocks.filter(b => {
      try {
        const parsed = JSON.parse(b);
        return 'approve' in parsed || 'deep_review' in parsed || 'disband' in parsed;
      } catch { return false; }
    });
    expect(actionPromptBlocks.length).toBeGreaterThanOrEqual(2);

    // Find the main actionPrompts (with approve/deep_review/close)
    const mainActions = actionPromptBlocks.find(b => b.includes('approve'));
    expect(mainActions).toBeDefined();
    const parsed = JSON.parse(mainActions!);
    expect(parsed).toHaveProperty('approve');
    expect(parsed).toHaveProperty('deep_review');
    expect(parsed).toHaveProperty('close');
  });
});
