/**
 * ExpertService - Manages human expert registry and skill declarations.
 *
 * Tracks experts registered through the bot and their skill profiles.
 * Stores expert metadata in workspace/experts.json.
 *
 * @see Issue #535 - 人类专家注册与技能声明
 * @see Issue #536 - 专家查询与匹配
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ExpertService');

/**
 * Skill level (1-5 self-assessment).
 */
export type SkillLevel = 1 | 2 | 3 | 4 | 5;

/**
 * Skill declaration by an expert.
 */
export interface SkillDeclaration {
  /** Skill name */
  name: string;
  /** Self-assessed level (1-5) */
  level: SkillLevel;
  /** Tags for categorization */
  tags?: string[];
  /** Optional description */
  description?: string;
}

/**
 * Expert profile.
 */
export interface ExpertProfile {
  /** Expert unique identifier (same as userId) */
  id: string;
  /** User ID (Feishu open_id) */
  userId: string;
  /** Display name */
  name: string;
  /** Declared skills */
  skills: SkillDeclaration[];
  /** Available hours (e.g., "weekdays 10:00-18:00") */
  availability?: string;
  /** Price per consultation in credits (default: 0 = free) */
  price?: number;
  /** Registration timestamp */
  registeredAt: number;
  /** Last update timestamp */
  updatedAt: number;
}

/**
 * Expert registry storage format.
 */
interface ExpertRegistry {
  /** Version for future migrations */
  version: number;
  /** Experts indexed by userId */
  experts: Record<string, ExpertProfile>;
}

/**
 * ExpertService configuration.
 */
export interface ExpertServiceConfig {
  /** Storage file path (default: workspace/experts.json) */
  filePath?: string;
}

/**
 * Service for managing human experts.
 *
 * Features:
 * - Register/unregister experts
 * - Manage skill declarations
 * - Persist expert profiles
 * - Search experts by skill
 */
export class ExpertService {
  private filePath: string;
  private registry: ExpertRegistry;

  constructor(config: ExpertServiceConfig = {}) {
    this.filePath = config.filePath || path.join(process.cwd(), 'workspace', 'experts.json');
    this.registry = this.load();
  }

  /**
   * Load registry from file.
   */
  private load(): ExpertRegistry {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        const data = JSON.parse(content) as ExpertRegistry;
        logger.info({ expertCount: Object.keys(data.experts || {}).length }, 'Expert registry loaded');
        return data;
      }
    } catch (error) {
      logger.warn({ err: error }, 'Failed to load expert registry, starting fresh');
    }
    return { version: 1, experts: {} };
  }

  /**
   * Save registry to file.
   */
  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.registry, null, 2));
      logger.debug({ expertCount: Object.keys(this.registry.experts).length }, 'Expert registry saved');
    } catch (error) {
      logger.error({ err: error }, 'Failed to save expert registry');
    }
  }

  /**
   * Register a new expert.
   *
   * @param userId - User ID (Feishu open_id)
   * @param name - Display name
   * @returns The created or updated expert profile
   */
  registerExpert(userId: string, name: string): ExpertProfile {
    const now = Date.now();
    const existing = this.registry.experts[userId];

    if (existing) {
      // Update existing expert
      existing.name = name;
      existing.updatedAt = now;
      this.save();
      logger.info({ userId, name }, 'Expert profile updated');
      return existing;
    }

    // Create new expert
    const profile: ExpertProfile = {
      id: userId,
      userId,
      name,
      skills: [],
      registeredAt: now,
      updatedAt: now,
    };

    this.registry.experts[userId] = profile;
    this.save();
    logger.info({ userId, name }, 'Expert registered');
    return profile;
  }

  /**
   * Unregister an expert.
   *
   * @param userId - User ID
   * @returns Whether the expert was removed
   */
  unregisterExpert(userId: string): boolean {
    if (this.registry.experts[userId]) {
      delete this.registry.experts[userId];
      this.save();
      logger.info({ userId }, 'Expert unregistered');
      return true;
    }
    return false;
  }

  /**
   * Get expert profile.
   *
   * @param userId - User ID
   * @returns Expert profile or undefined
   */
  getExpert(userId: string): ExpertProfile | undefined {
    return this.registry.experts[userId];
  }

  /**
   * Check if a user is a registered expert.
   *
   * @param userId - User ID
   */
  isExpert(userId: string): boolean {
    return userId in this.registry.experts;
  }

  /**
   * List all registered experts.
   *
   * @returns Array of expert profiles
   */
  listExperts(): ExpertProfile[] {
    return Object.values(this.registry.experts);
  }

  /**
   * Add a skill to an expert's profile.
   *
   * @param userId - User ID
   * @param skill - Skill declaration
   * @returns Updated profile or undefined if expert not found
   */
  addSkill(userId: string, skill: SkillDeclaration): ExpertProfile | undefined {
    const profile = this.registry.experts[userId];
    if (!profile) {
      logger.warn({ userId }, 'Cannot add skill: expert not found');
      return undefined;
    }

    // Check if skill already exists
    const existingIndex = profile.skills.findIndex(s => s.name.toLowerCase() === skill.name.toLowerCase());

    if (existingIndex >= 0) {
      // Update existing skill
      profile.skills[existingIndex] = skill;
    } else {
      // Add new skill
      profile.skills.push(skill);
    }

    profile.updatedAt = Date.now();
    this.save();
    logger.info({ userId, skillName: skill.name }, 'Skill added/updated');
    return profile;
  }

  /**
   * Remove a skill from an expert's profile.
   *
   * @param userId - User ID
   * @param skillName - Skill name to remove
   * @returns Updated profile or undefined if expert/skill not found
   */
  removeSkill(userId: string, skillName: string): ExpertProfile | undefined {
    const profile = this.registry.experts[userId];
    if (!profile) {
      logger.warn({ userId }, 'Cannot remove skill: expert not found');
      return undefined;
    }

    const initialLength = profile.skills.length;
    profile.skills = profile.skills.filter(s => s.name.toLowerCase() !== skillName.toLowerCase());

    if (profile.skills.length === initialLength) {
      logger.warn({ userId, skillName }, 'Skill not found');
      return undefined;
    }

    profile.updatedAt = Date.now();
    this.save();
    logger.info({ userId, skillName }, 'Skill removed');
    return profile;
  }

  /**
   * Set expert availability.
   *
   * @param userId - User ID
   * @param availability - Availability string
   * @returns Updated profile or undefined if expert not found
   */
  setAvailability(userId: string, availability: string): ExpertProfile | undefined {
    const profile = this.registry.experts[userId];
    if (!profile) {
      logger.warn({ userId }, 'Cannot set availability: expert not found');
      return undefined;
    }

    profile.availability = availability;
    profile.updatedAt = Date.now();
    this.save();
    logger.info({ userId, availability }, 'Availability set');
    return profile;
  }

  /**
   * Set expert price per consultation.
   *
   * @param userId - User ID
   * @param price - Price in credits (0 = free)
   * @returns Updated profile or undefined if expert not found
   */
  setPrice(userId: string, price: number): ExpertProfile | undefined {
    const profile = this.registry.experts[userId];
    if (!profile) {
      logger.warn({ userId }, 'Cannot set price: expert not found');
      return undefined;
    }

    if (price < 0) {
      logger.warn({ userId, price }, 'Cannot set negative price');
      return undefined;
    }

    profile.price = price;
    profile.updatedAt = Date.now();
    this.save();
    logger.info({ userId, price }, 'Expert price set');
    return profile;
  }

  /**
   * Search experts by skill name or tag.
   *
   * @param query - Skill name or tag to search for
   * @param minLevel - Minimum skill level filter (optional)
   * @param options - Additional search options
   * @returns Array of matching expert profiles
   */
  searchBySkill(
    query: string,
    minLevel?: SkillLevel,
    options?: { available?: boolean }
  ): ExpertProfile[] {
    const queryLower = query.toLowerCase();
    let results = Object.values(this.registry.experts).filter(expert => {
      return expert.skills.some(skill => {
        const nameMatch = skill.name.toLowerCase().includes(queryLower);
        const tagMatch = skill.tags?.some(t => t.toLowerCase().includes(queryLower)) ?? false;
        const levelMatch = minLevel === undefined || skill.level >= minLevel;
        return (nameMatch || tagMatch) && levelMatch;
      });
    });

    // Filter by availability if requested
    if (options?.available) {
      results = results.filter(expert => this.isExpertAvailable(expert.userId));
    }

    return results;
  }

  /**
   * Check if an expert is currently available.
   *
   * @param userId - Expert's user ID
   * @returns Whether the expert is available
   */
  isExpertAvailable(userId: string): boolean {
    const expert = this.registry.experts[userId];
    if (!expert) {
      return false;
    }

    // If no availability is set, consider expert as available
    if (!expert.availability) {
      return true;
    }

    return isAvailabilityMatch(expert.availability);
  }

  /**
   * Get the storage file path.
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Find experts by skill - API for Agent use.
   *
   * This is the primary API for AI agents to query experts.
   *
   * @param skill - Skill name to search for
   * @param options - Search options
   * @returns Promise resolving to array of matching expert profiles
   * @see Issue #536 - 专家查询与匹配
   */
  findExperts(
    skill: string,
    options?: {
      /** Minimum skill level (1-5) */
      minLevel?: number;
      /** Only return currently available experts */
      available?: boolean;
      /** Maximum number of results */
      limit?: number;
    }
  ): Promise<ExpertProfile[]> {
    const { minLevel, available, limit } = options || {};

    // Use searchBySkill for the actual search
    let results = this.searchBySkill(skill, minLevel as SkillLevel | undefined, { available });

    // Apply limit if specified
    if (limit !== undefined && limit > 0) {
      results = results.slice(0, limit);
    }

    logger.info({ skill, options, resultCount: results.length }, 'findExperts called');
    return Promise.resolve(results);
  }
}

// Singleton instance
let defaultInstance: ExpertService | undefined;

/**
 * Get the default ExpertService instance.
 */
export function getExpertService(): ExpertService {
  if (!defaultInstance) {
    defaultInstance = new ExpertService();
  }
  return defaultInstance;
}

/**
 * Check if current time matches the availability string.
 *
 * Supports formats:
 * - "weekdays 10:00-18:00" - Monday to Friday, 10:00 to 18:00
 * - "weekends 09:00-12:00" - Saturday and Sunday, 09:00 to 12:00
 * - "daily 09:00-17:00" - Every day
 * - "Mon-Fri 10:00-18:00" - Monday to Friday
 * - "always" - Always available
 *
 * @param availability - Availability string
 * @returns Whether current time matches
 */
export function isAvailabilityMatch(availability: string): boolean {
  const now = new Date();
  const currentDay = now.getDay(); // 0 = Sunday, 6 = Saturday
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const currentTime = currentHour * 60 + currentMinute;

  const availLower = availability.toLowerCase().trim();

  // "always" means always available
  if (availLower === 'always') {
    return true;
  }

  // Parse day range
  let dayMatch = true;
  let timeMatch = true;

  // Check for day patterns
  if (availLower.includes('weekdays') || availLower.includes('mon-fri') || availLower.includes('周一至周五')) {
    dayMatch = currentDay >= 1 && currentDay <= 5;
  } else if (availLower.includes('weekends') || availLower.includes('sat-sun') || availLower.includes('周末')) {
    dayMatch = currentDay === 0 || currentDay === 6;
  } else if (availLower.includes('daily') || availLower.includes('每天')) {
    dayMatch = true;
  }

  // Parse time range (format: HH:MM-HH:MM or H:MM-H:MM)
  const timeMatch_result = availLower.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
  if (timeMatch_result) {
    const startHour = parseInt(timeMatch_result[1], 10);
    const startMinute = parseInt(timeMatch_result[2], 10);
    const endHour = parseInt(timeMatch_result[3], 10);
    const endMinute = parseInt(timeMatch_result[4], 10);

    const startTime = startHour * 60 + startMinute;
    const endTime = endHour * 60 + endMinute;

    timeMatch = currentTime >= startTime && currentTime <= endTime;
  }

  return dayMatch && timeMatch;
}
