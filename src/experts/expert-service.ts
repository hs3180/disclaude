/**
 * ExpertService - Manages human expert registration and skill declaration.
 *
 * Stores expert profiles in workspace/experts.json.
 *
 * @see Issue #535 - 人类专家注册与技能声明
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type {
  ExpertProfile,
  ExpertRegistry,
  Skill,
  AddSkillOptions,
  RemoveSkillOptions,
  SetAvailabilityOptions,
} from './types.js';

const logger = createLogger('ExpertService');

/**
 * ExpertService configuration.
 */
export interface ExpertServiceConfig {
  /** Storage file path (default: workspace/experts.json) */
  filePath?: string;
}

/**
 * Service for managing human expert profiles.
 *
 * Features:
 * - Register/unregister experts
 * - Manage skill declarations
 * - Set availability schedules
 * - Persist expert data
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
   * @param userId - User's open_id
   * @returns The created expert profile
   */
  register(userId: string): ExpertProfile {
    const now = Date.now();

    // Check if already registered
    if (this.registry.experts[userId]) {
      logger.info({ userId }, 'User already registered as expert');
      return this.registry.experts[userId];
    }

    // Create new profile
    const profile: ExpertProfile = {
      userId,
      registeredAt: now,
      skills: [],
      updatedAt: now,
    };

    this.registry.experts[userId] = profile;
    this.save();

    logger.info({ userId }, 'Expert registered');
    return profile;
  }

  /**
   * Unregister an expert.
   *
   * @param userId - User's open_id
   * @returns Whether the expert was removed
   */
  unregister(userId: string): boolean {
    if (this.registry.experts[userId]) {
      delete this.registry.experts[userId];
      this.save();
      logger.info({ userId }, 'Expert unregistered');
      return true;
    }
    return false;
  }

  /**
   * Get an expert profile.
   *
   * @param userId - User's open_id
   * @returns Expert profile or undefined
   */
  getProfile(userId: string): ExpertProfile | undefined {
    return this.registry.experts[userId];
  }

  /**
   * Check if a user is registered as an expert.
   *
   * @param userId - User's open_id
   */
  isRegistered(userId: string): boolean {
    return userId in this.registry.experts;
  }

  /**
   * Add a skill to an expert's profile.
   *
   * @param options - Add skill options
   * @returns Updated profile or undefined if not registered
   */
  addSkill(options: AddSkillOptions): ExpertProfile | undefined {
    const { userId, name, level, tags } = options;
    const profile = this.registry.experts[userId];

    if (!profile) {
      logger.warn({ userId }, 'Cannot add skill: user not registered');
      return undefined;
    }

    // Check if skill already exists
    const existingIndex = profile.skills.findIndex(
      s => s.name.toLowerCase() === name.toLowerCase()
    );

    const skill: Skill = {
      name,
      level,
      tags: tags || [],
    };

    if (existingIndex >= 0) {
      // Update existing skill
      profile.skills[existingIndex] = skill;
      logger.info({ userId, skillName: name }, 'Skill updated');
    } else {
      // Add new skill
      profile.skills.push(skill);
      logger.info({ userId, skillName: name }, 'Skill added');
    }

    profile.updatedAt = Date.now();
    this.save();

    return profile;
  }

  /**
   * Remove a skill from an expert's profile.
   *
   * @param options - Remove skill options
   * @returns Updated profile or undefined if not registered
   */
  removeSkill(options: RemoveSkillOptions): ExpertProfile | undefined {
    const { userId, name } = options;
    const profile = this.registry.experts[userId];

    if (!profile) {
      logger.warn({ userId }, 'Cannot remove skill: user not registered');
      return undefined;
    }

    const initialLength = profile.skills.length;
    profile.skills = profile.skills.filter(
      s => s.name.toLowerCase() !== name.toLowerCase()
    );

    if (profile.skills.length === initialLength) {
      logger.warn({ userId, skillName: name }, 'Skill not found');
      return profile;
    }

    profile.updatedAt = Date.now();
    this.save();

    logger.info({ userId, skillName: name }, 'Skill removed');
    return profile;
  }

  /**
   * Set availability schedule for an expert.
   *
   * @param options - Set availability options
   * @returns Updated profile or undefined if not registered
   */
  setAvailability(options: SetAvailabilityOptions): ExpertProfile | undefined {
    const { userId, days, timeRange } = options;
    const profile = this.registry.experts[userId];

    if (!profile) {
      logger.warn({ userId }, 'Cannot set availability: user not registered');
      return undefined;
    }

    profile.availability = {
      days,
      timeRange,
    };

    profile.updatedAt = Date.now();
    this.save();

    logger.info({ userId, days, timeRange }, 'Availability set');
    return profile;
  }

  /**
   * Clear availability schedule for an expert.
   *
   * @param userId - User's open_id
   * @returns Updated profile or undefined if not registered
   */
  clearAvailability(userId: string): ExpertProfile | undefined {
    const profile = this.registry.experts[userId];

    if (!profile) {
      logger.warn({ userId }, 'Cannot clear availability: user not registered');
      return undefined;
    }

    delete profile.availability;
    profile.updatedAt = Date.now();
    this.save();

    logger.info({ userId }, 'Availability cleared');
    return profile;
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
   * Find experts by skill name (case-insensitive partial match).
   *
   * @param skillName - Skill name to search for
   * @returns Array of matching expert profiles
   */
  findBySkill(skillName: string): ExpertProfile[] {
    const searchName = skillName.toLowerCase();
    return Object.values(this.registry.experts).filter(profile =>
      profile.skills.some(skill =>
        skill.name.toLowerCase().includes(searchName)
      )
    );
  }

  /**
   * Find experts by tag (case-insensitive).
   *
   * @param tag - Tag to search for
   * @returns Array of matching expert profiles
   */
  findByTag(tag: string): ExpertProfile[] {
    const searchTag = tag.toLowerCase();
    return Object.values(this.registry.experts).filter(profile =>
      profile.skills.some(skill =>
        skill.tags.some(t => t.toLowerCase() === searchTag)
      )
    );
  }

  /**
   * Get the storage file path.
   */
  getFilePath(): string {
    return this.filePath;
  }
}

// Singleton instance for convenience
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
