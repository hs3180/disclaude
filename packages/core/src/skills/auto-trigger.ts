/**
 * Skill Auto-Trigger - Automatic skill matching and injection based on user messages.
 *
 * Issue #3687: Implements deterministic keyword-based skill matching
 * to supplement the SDK's built-in skill auto-invocation mechanism.
 *
 * The SDK's auto-invocation relies on the LLM interpreting skill descriptions,
 * which can be unreliable. This module provides deterministic keyword matching
 * by parsing SKILL.md frontmatter for trigger keywords and matching them
 * against incoming user messages.
 *
 * Flow:
 * 1. User message arrives at ChatAgent.processMessage()
 * 2. matchSkills() scans message against skill keywords
 * 3. Matching skills' content is injected into the message context
 * 4. Agent processes the message with skill instructions already available
 *
 * @module skills/auto-trigger
 */

import * as fs from 'fs/promises';
import { listSkills } from './finder.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SkillAutoTrigger');

/**
 * Parsed skill metadata from SKILL.md frontmatter.
 */
export interface SkillMetadata {
  /** Skill name */
  name: string;
  /** Whether model invocation is disabled */
  disableModelInvocation: boolean;
  /** Whether user invocation is enabled */
  userInvocable: boolean;
  /** Extracted trigger keywords from description */
  keywords: string[];
}

/**
 * Result of skill auto-trigger matching.
 */
export interface MatchedSkillResult {
  /** Skill name */
  name: string;
  /** Skill file path */
  path: string;
  /** Keywords that matched the user message */
  matchedKeywords: string[];
  /** Full SKILL.md content */
  content: string;
}

/**
 * Parse YAML frontmatter from SKILL.md content.
 * Simple line-by-line parser for basic key-value pairs.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {return {};}

  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {continue;}

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    result[key] = value;
  }
  return result;
}

/**
 * Extract trigger keywords from a skill description.
 *
 * Extracts quoted strings (single or double) from the description text.
 * Skills typically list trigger keywords in quotes within their description,
 * e.g., Triggered by keywords: "schedule", "定时任务", "cron"
 */
function extractKeywords(description: string): string[] {
  const keywords: Set<string> = new Set();

  const quotedRegex = /["']([^"']+)["']/g;
  let match;
  while ((match = quotedRegex.exec(description)) !== null) {
    const keyword = match[1].trim();
    if (keyword.length > 0) {
      keywords.add(keyword);
    }
  }

  return Array.from(keywords);
}

/**
 * Parse skill metadata from SKILL.md content.
 */
function parseSkillMetadata(content: string): SkillMetadata {
  const frontmatter = parseFrontmatter(content);
  const description = frontmatter['description'] || '';

  return {
    name: frontmatter['name'] || '',
    disableModelInvocation: frontmatter['disable-model-invocation'] === 'true',
    userInvocable: frontmatter['user-invocable'] !== 'false',
    keywords: extractKeywords(description),
  };
}

/** Cache for skill metadata to avoid re-reading files on every message. */
let cachedMetadata: Map<string, { metadata: SkillMetadata; content: string }> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Get all skill metadata with caching.
 *
 * @returns Map of skill name to metadata and content
 */
async function getSkillsMetadata(): Promise<Map<string, { metadata: SkillMetadata; content: string }>> {
  const now = Date.now();
  if (cachedMetadata && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedMetadata;
  }

  const skills = await listSkills();
  const map = new Map<string, { metadata: SkillMetadata; content: string }>();

  for (const skill of skills) {
    try {
      const content = await fs.readFile(skill.path, 'utf-8');
      const metadata = parseSkillMetadata(content);
      map.set(skill.name, { metadata, content });
    } catch (error) {
      logger.debug({ error, skill: skill.name }, 'Failed to read skill for auto-trigger');
    }
  }

  cachedMetadata = map;
  cacheTimestamp = now;
  return map;
}

/**
 * Invalidate the skill metadata cache.
 *
 * Call this when skills are added, removed, or modified.
 */
export function invalidateCache(): void {
  cachedMetadata = null;
  cacheTimestamp = 0;
}

/**
 * Maximum number of skills to auto-inject per message.
 * Prevents context bloat from too many matched skills.
 */
const MAX_MATCHES = 3;

/**
 * Match a user message against skill keywords.
 *
 * Scans the message text against all available skills' trigger keywords.
 * Returns matching skills sorted by number of keyword matches (descending).
 * Respects the `disable-model-invocation` flag — skills with this flag set
 * are excluded from auto-trigger.
 *
 * @param userMessage - The user's message text
 * @returns Array of matched skills with their content (limited to MAX_MATCHES)
 */
export async function matchSkills(userMessage: string): Promise<MatchedSkillResult[]> {
  const lowerMessage = userMessage.toLowerCase();
  const metadataMap = await getSkillsMetadata();
  const results: MatchedSkillResult[] = [];

  for (const [, entry] of metadataMap) {
    const { metadata, content } = entry;

    // Skip skills that opt out of model invocation
    if (metadata.disableModelInvocation) {continue;}

    // Check for keyword matches
    const matchedKeywords = metadata.keywords.filter(kw =>
      lowerMessage.includes(kw.toLowerCase())
    );

    if (matchedKeywords.length > 0) {
      results.push({
        name: metadata.name,
        path: '',
        matchedKeywords,
        content,
      });
    }
  }

  // Sort by match count (descending), limit results
  results.sort((a, b) => b.matchedKeywords.length - a.matchedKeywords.length);
  const limited = results.slice(0, MAX_MATCHES);

  if (limited.length > 0) {
    logger.info(
      {
        messageLength: userMessage.length,
        matches: limited.map(r => ({ name: r.name, keywords: r.matchedKeywords })),
      },
      'Auto-trigger matched skills'
    );
  }

  return limited;
}

/**
 * Build injection content for matched skills.
 *
 * Formats matched skill content for inclusion in the user message.
 * Strips YAML frontmatter from the skill content since the agent
 * only needs the markdown instructions.
 *
 * @param matches - Matched skills from matchSkills()
 * @returns Formatted string for injection, or empty string if no matches
 */
export function buildSkillInjection(matches: MatchedSkillResult[]): string {
  if (matches.length === 0) {return '';}

  const parts = matches.map(match => {
    // Strip frontmatter — agent only needs the markdown instructions
    const body = match.content.replace(/^---\n[\s\S]*?\n---\n*/, '');
    return `### Auto-loaded Skill: ${match.name}\nMatched keywords: ${match.matchedKeywords.join(', ')}\n\n${body}`;
  });

  return `\n--- Auto-loaded Skills ---\n${parts.join('\n\n---\n\n')}\n--- End Auto-loaded Skills ---\n`;
}
