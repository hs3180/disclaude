/**
 * ExpertService - Manages human expert registry and skill declarations.
 *
 * Tracks experts registered through the bot and their skill profiles.
 * Stores expert metadata in workspace/experts.json.
 *
 * @see Issue #535 - 人类专家注册与技能声明
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
   * Search experts by skill name or tag.
   *
   * @param query - Skill name or tag to search for
   * @param minLevel - Minimum skill level filter (optional)
   * @returns Array of matching expert profiles
   */
  searchBySkill(query: string, minLevel?: SkillLevel): ExpertProfile[] {
    const queryLower = query.toLowerCase();
    return Object.values(this.registry.experts).filter(expert => {
      return expert.skills.some(skill => {
        const nameMatch = skill.name.toLowerCase().includes(queryLower);
        const tagMatch = skill.tags?.some(t => t.toLowerCase().includes(queryLower)) ?? false;
        const levelMatch = minLevel === undefined || skill.level >= minLevel;
        return (nameMatch || tagMatch) && levelMatch;
      });
    });
  }

  /**
   * Get the storage file path.
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Check if an expert is currently available.
   *
   * Parses the availability string and checks if the current time falls within
   * the specified time range.
   *
   * Supported formats:
   * - "weekdays 9:00-18:00" - Available on weekdays (Mon-Fri) during hours
   * - "weekends 10:00-20:00" - Available on weekends (Sat-Sun) during hours
   * - "daily 9:00-18:00" - Available every day during hours
   * - "9:00-18:00" - Available every day during hours (same as daily)
   * - "always" or empty - Always available
   *
   * @param userId - User ID
   * @returns Whether the expert is currently available
   */
  isAvailable(userId: string): boolean {
    const profile = this.registry.experts[userId];
    if (!profile) {
      return false;
    }

    // If no availability set, consider always available
    if (!profile.availability) {
      return true;
    }

    const availability = profile.availability.toLowerCase().trim();

    // Always available
    if (availability === 'always' || availability === '') {
      return true;
    }

    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sunday, 6 = Saturday
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTime = currentHour * 60 + currentMinute; // Minutes since midnight

    // Parse time range (e.g., "9:00-18:00")
    const timeMatch = availability.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
    if (!timeMatch) {
      // If we can't parse the time, consider available
      logger.warn({ userId, availability }, 'Could not parse availability, considering available');
      return true;
    }

    const [, startHour, startMin, endHour, endMin] = timeMatch.map(Number);
    const startTime = startHour * 60 + startMin;
    const endTime = endHour * 60 + endMin;

    const inTimeRange = currentTime >= startTime && currentTime <= endTime;

    // Check day constraints
    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    if (availability.includes('weekday')) {
      return isWeekday && inTimeRange;
    }

    if (availability.includes('weekend')) {
      return isWeekend && inTimeRange;
    }

    // "daily" or just time range - available any day
    return inTimeRange;
  }

  /**
   * Search for available experts by skill.
   *
   * Combines skill search with availability check.
   *
   * @param query - Skill name or tag to search for
   * @param options - Search options
   * @returns Array of matching expert profiles that are currently available
   */
  searchAvailableExperts(
    query: string,
    options?: {
      minLevel?: SkillLevel;
      checkAvailability?: boolean;
    }
  ): ExpertProfile[] {
    const { minLevel, checkAvailability = true } = options || {};
    const experts = this.searchBySkill(query, minLevel);

    if (!checkAvailability) {
      return experts;
    }

    return experts.filter(expert => this.isAvailable(expert.userId));
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
