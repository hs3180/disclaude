/**
 * Expert Manager - Manages expert registration and skill declaration.
 *
 * Provides functionality for:
 * - Registering experts
 * - Managing skills
 * - Setting availability
 * - Persisting expert data to workspace
 *
 * Issue #535: 人类专家注册与技能声明
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import type { Expert, ExpertRegistry, ExpertAvailability, Skill, SkillLevel } from './types.js';

const logger = createLogger('ExpertManager', {});

/**
 * Expert Manager for managing expert profiles.
 */
export class ExpertManager {
  private readonly dataFile: string;
  private registry: ExpertRegistry | null = null;

  constructor(baseDir?: string) {
    const workspaceDir = baseDir || Config.getWorkspaceDir();
    this.dataFile = path.join(workspaceDir, 'experts.json');
  }

  /**
   * Ensure the data directory exists.
   */
  private async ensureDataDir(): Promise<void> {
    const dir = path.dirname(this.dataFile);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      logger.error({ err: error }, 'Failed to create data directory');
    }
  }

  /**
   * Load registry from disk.
   */
  private async loadRegistry(): Promise<ExpertRegistry> {
    if (this.registry) {
      return this.registry;
    }

    try {
      const content = await fs.readFile(this.dataFile, 'utf-8');
      this.registry = JSON.parse(content);
    } catch {
      // File doesn't exist or is invalid, create empty registry
      this.registry = { experts: [] };
    }

    // At this point, this.registry is guaranteed to be set
    return this.registry!;
  }

  /**
   * Save registry to disk.
   */
  private async saveRegistry(): Promise<void> {
    await this.ensureDataDir();

    if (this.registry) {
      await fs.writeFile(
        this.dataFile,
        JSON.stringify(this.registry, null, 2),
        'utf-8'
      );
    }
  }

  /**
   * Register a new expert or update existing one.
   *
   * @param openId - Feishu open_id
   * @param name - Display name (optional)
   * @returns The expert profile
   */
  async registerExpert(openId: string, name?: string): Promise<Expert> {
    const registry = await this.loadRegistry();

    // Check if expert already exists
    let expert = registry.experts.find(e => e.open_id === openId);

    if (expert) {
      // Update existing expert
      if (name) {
        expert.name = name;
      }
      expert.updatedAt = new Date().toISOString();
    } else {
      // Create new expert
      const now = new Date().toISOString();
      expert = {
        open_id: openId,
        name,
        skills: [],
        createdAt: now,
        updatedAt: now,
      };
      registry.experts.push(expert);
    }

    await this.saveRegistry();
    logger.info({ openId }, 'Expert registered');

    return expert;
  }

  /**
   * Get expert by open_id.
   *
   * @param openId - Feishu open_id
   * @returns Expert profile or undefined
   */
  async getExpert(openId: string): Promise<Expert | undefined> {
    const registry = await this.loadRegistry();
    return registry.experts.find(e => e.open_id === openId);
  }

  /**
   * List all experts.
   *
   * @returns Array of experts
   */
  async listExperts(): Promise<Expert[]> {
    const registry = await this.loadRegistry();
    return registry.experts;
  }

  /**
   * Add a skill to an expert.
   *
   * @param openId - Feishu open_id
   * @param skillName - Skill name
   * @param level - Skill level (1-5)
   * @param tags - Optional tags
   * @returns Updated expert or undefined if not found
   */
  async addSkill(
    openId: string,
    skillName: string,
    level: SkillLevel,
    tags?: string[]
  ): Promise<Expert | undefined> {
    const registry = await this.loadRegistry();
    const expert = registry.experts.find(e => e.open_id === openId);

    if (!expert) {
      return undefined;
    }

    // Check if skill already exists
    const existingIndex = expert.skills.findIndex(
      s => s.name.toLowerCase() === skillName.toLowerCase()
    );

    const skill: Skill = {
      name: skillName,
      level,
      tags,
    };

    if (existingIndex >= 0) {
      // Update existing skill
      expert.skills[existingIndex] = skill;
    } else {
      // Add new skill
      expert.skills.push(skill);
    }

    expert.updatedAt = new Date().toISOString();
    await this.saveRegistry();
    logger.info({ openId, skillName, level }, 'Skill added to expert');

    return expert;
  }

  /**
   * Remove a skill from an expert.
   *
   * @param openId - Feishu open_id
   * @param skillName - Skill name to remove
   * @returns Updated expert or undefined if not found
   */
  async removeSkill(openId: string, skillName: string): Promise<Expert | undefined> {
    const registry = await this.loadRegistry();
    const expert = registry.experts.find(e => e.open_id === openId);

    if (!expert) {
      return undefined;
    }

    const initialLength = expert.skills.length;
    expert.skills = expert.skills.filter(
      s => s.name.toLowerCase() !== skillName.toLowerCase()
    );

    if (expert.skills.length === initialLength) {
      // Skill not found
      return expert;
    }

    expert.updatedAt = new Date().toISOString();
    await this.saveRegistry();
    logger.info({ openId, skillName }, 'Skill removed from expert');

    return expert;
  }

  /**
   * Set expert availability.
   *
   * @param openId - Feishu open_id
   * @param availability - Availability settings
   * @returns Updated expert or undefined if not found
   */
  async setAvailability(
    openId: string,
    availability: ExpertAvailability
  ): Promise<Expert | undefined> {
    const registry = await this.loadRegistry();
    const expert = registry.experts.find(e => e.open_id === openId);

    if (!expert) {
      return undefined;
    }

    expert.availability = availability;
    expert.updatedAt = new Date().toISOString();
    await this.saveRegistry();
    logger.info({ openId, availability }, 'Expert availability set');

    return expert;
  }

  /**
   * Unregister an expert.
   *
   * @param openId - Feishu open_id
   * @returns True if expert was removed, false if not found
   */
  async unregisterExpert(openId: string): Promise<boolean> {
    const registry = await this.loadRegistry();
    const initialLength = registry.experts.length;

    registry.experts = registry.experts.filter(e => e.open_id !== openId);

    if (registry.experts.length === initialLength) {
      return false;
    }

    await this.saveRegistry();
    logger.info({ openId }, 'Expert unregistered');

    return true;
  }
}

// Singleton instance
let expertManagerInstance: ExpertManager | undefined;

/**
 * Get the global ExpertManager instance.
 */
export function getExpertManager(): ExpertManager {
  if (!expertManagerInstance) {
    expertManagerInstance = new ExpertManager();
  }
  return expertManagerInstance;
}

/**
 * Reset the global ExpertManager (for testing).
 */
export function resetExpertManager(): void {
  expertManagerInstance = undefined;
}
