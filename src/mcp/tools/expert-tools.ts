/**
 * Expert Tools - MCP tools for expert search and matching.
 *
 * Provides tools for Agent to find and match human experts.
 *
 * @see Issue #536 - 专家查询与匹配
 */

import { getExpertService, type ExpertProfile, type SkillLevel } from '../../experts/index.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('expert-tools');

/**
 * Options for find_experts tool.
 */
export interface FindExpertsOptions {
  /** Skill name or tag to search for */
  skill: string;
  /** Minimum skill level filter (1-5) */
  minLevel?: SkillLevel;
  /** Only return currently available experts */
  availableOnly?: boolean;
  /** Maximum number of results to return */
  limit?: number;
}

/**
 * Expert match result with skill details.
 */
export interface ExpertMatch {
  /** Expert user ID */
  userId: string;
  /** Expert display name */
  name: string;
  /** Matching skills */
  matchingSkills: Array<{
    name: string;
    level: SkillLevel;
    tags?: string[];
  }>;
  /** Availability string */
  availability?: string;
  /** Whether expert is currently available */
  isAvailable: boolean;
}

/**
 * Result of find_experts tool.
 */
export interface FindExpertsResult {
  /** Whether the search was successful */
  success: boolean;
  /** Number of experts found */
  count: number;
  /** Matching experts */
  experts: ExpertMatch[];
  /** Error message if failed */
  error?: string;
}

/**
 * Check if an expert is currently available based on their availability string.
 *
 * Supports formats like:
 * - "weekdays 10:00-18:00"
 * - "工作日 9:00-18:00"
 * - "Mon-Fri 09:00-17:00"
 * - "always" / "anytime"
 *
 * @param availability - Availability string
 * @returns Whether the expert is currently available
 */
export function checkAvailability(availability?: string): boolean {
  if (!availability) {
    // No availability set, assume available
    return true;
  }

  const lower = availability.toLowerCase();
  const now = new Date();

  // Always available patterns
  if (lower.includes('always') || lower.includes('anytime') || lower.includes('全天') || lower.includes('随时')) {
    return true;
  }

  // Parse time range
  const timeMatch = availability.match(/(\d{1,2}):(\d{2})\s*[-~到]\s*(\d{1,2}):(\d{2})/);
  if (!timeMatch) {
    // Can't parse, assume available
    return true;
  }

  const [, startHour, startMin, endHour, endMin] = timeMatch.map(Number);
  const currentHour = now.getHours();
  const currentMin = now.getMinutes();
  const currentTime = currentHour * 60 + currentMin;
  const startTime = startHour * 60 + startMin;
  const endTime = endHour * 60 + endMin;

  // Check if current time is within range
  const timeInRange = currentTime >= startTime && currentTime <= endTime;

  // Check day of week
  const dayOfWeek = now.getDay(); // 0 = Sunday, 6 = Saturday
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  // Check day patterns
  const isWeekdayPattern = lower.includes('weekday') || lower.includes('工作日') || lower.includes('周一至周五');
  const isWeekendPattern = lower.includes('weekend') || lower.includes('周末');

  if (isWeekdayPattern) {
    return isWeekday && timeInRange;
  }
  if (isWeekendPattern) {
    return isWeekend && timeInRange;
  }

  // Default: just check time range
  return timeInRange;
}

/**
 * Find experts by skill.
 *
 * @param options - Search options
 * @returns Search result with matching experts
 */
export function find_experts(options: FindExpertsOptions): FindExpertsResult {
  const { skill, minLevel, availableOnly = false, limit } = options;

  if (!skill || skill.trim().length === 0) {
    return {
      success: false,
      count: 0,
      experts: [],
      error: '请提供要搜索的技能名称',
    };
  }

  try {
    const expertService = getExpertService();
    const matchingProfiles = expertService.searchBySkill(skill.trim(), minLevel);

    // Convert to ExpertMatch format
    let experts: ExpertMatch[] = matchingProfiles.map(profile => {
      const queryLower = skill.toLowerCase();
      const matchingSkills = profile.skills.filter(s =>
        s.name.toLowerCase().includes(queryLower) ||
        (s.tags?.some(t => t.toLowerCase().includes(queryLower)) ?? false)
      );

      return {
        userId: profile.userId,
        name: profile.name,
        matchingSkills: matchingSkills.map(s => ({
          name: s.name,
          level: s.level,
          tags: s.tags,
        })),
        availability: profile.availability,
        isAvailable: checkAvailability(profile.availability),
      };
    });

    // Filter by availability if requested
    if (availableOnly) {
      experts = experts.filter(e => e.isAvailable);
    }

    // Sort by: available first, then by highest skill level
    experts.sort((a, b) => {
      // Available experts first
      if (a.isAvailable !== b.isAvailable) {
        return a.isAvailable ? -1 : 1;
      }
      // Then by highest skill level
      const aMaxLevel = Math.max(...a.matchingSkills.map(s => s.level));
      const bMaxLevel = Math.max(...b.matchingSkills.map(s => s.level));
      return bMaxLevel - aMaxLevel;
    });

    // Apply limit
    if (limit !== undefined && limit > 0) {
      experts = experts.slice(0, limit);
    }

    logger.info({ skill, minLevel, availableOnly, resultCount: experts.length }, 'Expert search completed');

    return {
      success: true,
      count: experts.length,
      experts,
    };
  } catch (error) {
    logger.error({ err: error, skill }, 'Expert search failed');
    return {
      success: false,
      count: 0,
      experts: [],
      error: `搜索失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * List all registered experts.
 *
 * @param options - List options
 * @returns List of all experts
 */
export function list_experts(options?: { availableOnly?: boolean; limit?: number }): FindExpertsResult {
  try {
    const expertService = getExpertService();
    const allProfiles = expertService.listExperts();

    let experts: ExpertMatch[] = allProfiles.map(profile => ({
      userId: profile.userId,
      name: profile.name,
      matchingSkills: profile.skills.map(s => ({
        name: s.name,
        level: s.level,
        tags: s.tags,
      })),
      availability: profile.availability,
      isAvailable: checkAvailability(profile.availability),
    }));

    // Filter by availability if requested
    if (options?.availableOnly) {
      experts = experts.filter(e => e.isAvailable);
    }

    // Sort by availability
    experts.sort((a, b) => {
      if (a.isAvailable !== b.isAvailable) {
        return a.isAvailable ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    // Apply limit
    if (options?.limit !== undefined && options.limit > 0) {
      experts = experts.slice(0, options.limit);
    }

    logger.info({ availableOnly: options?.availableOnly, resultCount: experts.length }, 'Expert list completed');

    return {
      success: true,
      count: experts.length,
      experts,
    };
  } catch (error) {
    logger.error({ err: error }, 'Expert list failed');
    return {
      success: false,
      count: 0,
      experts: [],
      error: `获取列表失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
