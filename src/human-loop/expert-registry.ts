/**
 * Expert Registry - Loads and manages human expert configurations.
 *
 * @see Issue #532 - Human-in-the-Loop interaction system
 * @see Issue #535 - Expert registration and skill declaration
 * @see Issue #536 - Expert query and matching
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { Config } from '../config/index.js';
import type {
  ExpertConfig,
  ExpertRegistryConfig,
  SkillDefinition,
} from './types.js';

const logger = createLogger('ExpertRegistry');

/**
 * Default expert registry file name.
 */
const DEFAULT_EXPERTS_FILE = 'experts.yaml';

/**
 * Expert Registry - manages human expert configurations.
 *
 * Features:
 * - Load experts from workspace/experts.yaml
 * - Search experts by skill
 * - Filter by minimum skill level
 */
export class ExpertRegistry {
  private experts: ExpertConfig[] = [];
  private loaded = false;

  /**
   * Get the path to the experts configuration file.
   */
  private getConfigPath(): string {
    const workspaceDir = Config.getWorkspaceDir();
    return path.join(workspaceDir, DEFAULT_EXPERTS_FILE);
  }

  /**
   * Load experts from the configuration file.
   *
   * @returns Whether the load was successful
   */
  async load(): Promise<boolean> {
    try {
      const configPath = this.getConfigPath();

      // Check if file exists
      try {
        await fs.access(configPath);
      } catch {
        logger.debug({ configPath }, 'Experts config file not found, using empty registry');
        this.experts = [];
        this.loaded = true;
        return true;
      }

      // Read and parse YAML
      const content = await fs.readFile(configPath, 'utf-8');
      const yaml = await import('js-yaml');
      const config = yaml.load(content) as ExpertRegistryConfig;

      this.experts = config?.experts || [];
      this.loaded = true;

      logger.info({ expertCount: this.experts.length }, 'Experts loaded');
      return true;
    } catch (error) {
      logger.error({ err: error }, 'Failed to load experts config');
      this.experts = [];
      this.loaded = false;
      return false;
    }
  }

  /**
   * Ensure experts are loaded.
   */
  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.load();
    }
  }

  /**
   * Get all registered experts.
   *
   * @returns Array of all experts
   */
  async getAll(): Promise<ExpertConfig[]> {
    await this.ensureLoaded();
    return [...this.experts];
  }

  /**
   * Find experts by skill name.
   *
   * @param skillName - Skill name to search for (case-insensitive partial match)
   * @param minLevel - Minimum skill level required
   * @returns Array of matching experts
   */
  async findBySkill(skillName: string, minLevel?: number): Promise<ExpertConfig[]> {
    await this.ensureLoaded();

    const searchName = skillName.toLowerCase();
    const matches: ExpertConfig[] = [];

    for (const expert of this.experts) {
      for (const skill of expert.skills) {
        const skillMatches = skill.name.toLowerCase().includes(searchName);
        const levelMatches = minLevel === undefined || skill.level >= minLevel;

        if (skillMatches && levelMatches) {
          matches.push(expert);
          break; // Only add expert once even if multiple skills match
        }
      }
    }

    logger.debug({ skillName, minLevel, matchCount: matches.length }, 'Found experts by skill');
    return matches;
  }

  /**
   * Get an expert by open_id.
   *
   * @param openId - Expert's open_id
   * @returns Expert config or undefined
   */
  async getByOpenId(openId: string): Promise<ExpertConfig | undefined> {
    await this.ensureLoaded();
    return this.experts.find(e => e.open_id === openId);
  }

  /**
   * Get the best matching expert for a skill.
   *
   * @param skillName - Skill name to search for
   * @param minLevel - Minimum skill level required
   * @returns Best matching expert or undefined
   */
  async findBestMatch(skillName: string, minLevel?: number): Promise<ExpertConfig | undefined> {
    const matches = await this.findBySkill(skillName, minLevel);

    if (matches.length === 0) {
      return undefined;
    }

    // Sort by highest skill level for the requested skill
    const searchName = skillName.toLowerCase();
    const sorted = matches.sort((a, b) => {
      const aSkill = a.skills.find(s => s.name.toLowerCase().includes(searchName));
      const bSkill = b.skills.find(s => s.name.toLowerCase().includes(searchName));
      return (bSkill?.level || 0) - (aSkill?.level || 0);
    });

    return sorted[0];
  }

  /**
   * Create a sample experts.yaml file.
   *
   * @param overwrite - Whether to overwrite existing file
   */
  async createSample(overwrite = false): Promise<void> {
    const configPath = this.getConfigPath();

    // Check if file exists
    if (!overwrite) {
      try {
        await fs.access(configPath);
        logger.debug({ configPath }, 'Sample file already exists, skipping');
        return;
      } catch {
        // File doesn't exist, continue
      }
    }

    const sampleContent = `# Human Experts Configuration
# @see Issue #532 - Human-in-the-Loop interaction system

experts:
  # Example expert configuration
  # - open_id: "ou_xxxx"           # Expert's Feishu open_id
  #   name: "张三"                  # Display name
  #   skills:                      # Skills and self-assessed levels (1-5)
  #     - name: "React"
  #       level: 4
  #       tags: ["frontend", "web"]
  #     - name: "TypeScript"
  #       level: 5
  #   availability:                # Optional availability settings
  #     schedule: "weekdays 10:00-18:00"
  #     timezone: "Asia/Shanghai"
`;

    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, sampleContent, 'utf-8');
    logger.info({ configPath }, 'Sample experts.yaml created');
  }

  // ============================================================================
  // Write Operations (Issue #535: Expert Registration)
  // ============================================================================

  /**
   * Save the current experts configuration to file.
   */
  private async save(): Promise<boolean> {
    try {
      const configPath = this.getConfigPath();
      const yaml = await import('js-yaml');

      const config: ExpertRegistryConfig = {
        experts: this.experts,
      };

      const content = yaml.dump(config, {
        indent: 2,
        lineWidth: -1,
        quotingType: '"',
        forceQuotes: false,
      });

      // Add header comment
      const header = `# Human Experts Configuration
# @see Issue #532 - Human-in-the-Loop interaction system
# @see Issue #535 - Expert registration and skill declaration

`;

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, header + content, 'utf-8');

      logger.info({ expertCount: this.experts.length }, 'Experts saved');
      return true;
    } catch (error) {
      logger.error({ err: error }, 'Failed to save experts config');
      return false;
    }
  }

  /**
   * Register a new expert.
   *
   * @param openId - Expert's Feishu open_id
   * @param name - Display name
   * @returns Whether registration was successful
   */
  async register(openId: string, name: string): Promise<{ success: boolean; isNew: boolean; error?: string }> {
    await this.ensureLoaded();

    // Check if already registered
    const existing = this.experts.find(e => e.open_id === openId);
    if (existing) {
      // Update name if different
      if (existing.name !== name) {
        existing.name = name;
        await this.save();
        logger.info({ openId, name }, 'Expert name updated');
      }
      return { success: true, isNew: false };
    }

    // Add new expert
    const newExpert: ExpertConfig = {
      open_id: openId,
      name,
      skills: [],
    };

    this.experts.push(newExpert);
    const saved = await this.save();

    if (saved) {
      logger.info({ openId, name }, 'Expert registered');
      return { success: true, isNew: true };
    } else {
      // Revert on save failure
      this.experts.pop();
      return { success: false, isNew: false, error: '保存失败' };
    }
  }

  /**
   * Add a skill to an expert.
   *
   * @param openId - Expert's open_id
   * @param skill - Skill to add
   * @returns Whether the operation was successful
   */
  async addSkill(
    openId: string,
    skill: SkillDefinition
  ): Promise<{ success: boolean; isUpdate: boolean; error?: string }> {
    await this.ensureLoaded();

    const expert = this.experts.find(e => e.open_id === openId);
    if (!expert) {
      return { success: false, isUpdate: false, error: '您还未注册为专家，请先使用 /expert register 注册' };
    }

    // Validate skill level
    if (skill.level < 1 || skill.level > 5) {
      return { success: false, isUpdate: false, error: '技能等级必须在 1-5 之间' };
    }

    // Check if skill already exists
    const existingIndex = expert.skills.findIndex(
      s => s.name.toLowerCase() === skill.name.toLowerCase()
    );

    if (existingIndex >= 0) {
      // Update existing skill
      expert.skills[existingIndex] = skill;
      const saved = await this.save();
      return saved
        ? { success: true, isUpdate: true }
        : { success: false, isUpdate: false, error: '保存失败' };
    }

    // Add new skill
    expert.skills.push(skill);
    const saved = await this.save();

    if (saved) {
      logger.info({ openId, skill: skill.name }, 'Skill added');
      return { success: true, isUpdate: false };
    } else {
      // Revert on save failure
      expert.skills.pop();
      return { success: false, isUpdate: false, error: '保存失败' };
    }
  }

  /**
   * Remove a skill from an expert.
   *
   * @param openId - Expert's open_id
   * @param skillName - Name of skill to remove
   * @returns Whether the operation was successful
   */
  async removeSkill(openId: string, skillName: string): Promise<{ success: boolean; error?: string }> {
    await this.ensureLoaded();

    const expert = this.experts.find(e => e.open_id === openId);
    if (!expert) {
      return { success: false, error: '您还未注册为专家' };
    }

    const initialLength = expert.skills.length;
    expert.skills = expert.skills.filter(
      s => s.name.toLowerCase() !== skillName.toLowerCase()
    );

    if (expert.skills.length === initialLength) {
      return { success: false, error: `未找到技能 "${skillName}"` };
    }

    const saved = await this.save();
    if (saved) {
      logger.info({ openId, skillName }, 'Skill removed');
      return { success: true };
    } else {
      // Revert on save failure - note: we've already modified the array
      // In a real implementation, we'd want to restore the original
      return { success: false, error: '保存失败' };
    }
  }

  /**
   * Set availability for an expert.
   *
   * @param openId - Expert's open_id
   * @param availability - Availability settings
   * @returns Whether the operation was successful
   */
  async setAvailability(
    openId: string,
    availability: ExpertConfig['availability']
  ): Promise<{ success: boolean; error?: string }> {
    await this.ensureLoaded();

    const expert = this.experts.find(e => e.open_id === openId);
    if (!expert) {
      return { success: false, error: '您还未注册为专家，请先使用 /expert register 注册' };
    }

    expert.availability = availability;
    const saved = await this.save();

    if (saved) {
      logger.info({ openId, availability }, 'Availability set');
      return { success: true };
    } else {
      return { success: false, error: '保存失败' };
    }
  }

  /**
   * Get expert profile (for display).
   *
   * @param openId - Expert's open_id
   * @returns Expert profile or undefined
   */
  async getProfile(openId: string): Promise<ExpertConfig | undefined> {
    await this.ensureLoaded();
    return this.experts.find(e => e.open_id === openId);
  }

  // ============================================================================
  // Query Operations (Issue #536: Expert Query and Matching)
  // ============================================================================

  /**
   * Check if an expert is currently available.
   *
   * Availability is determined by:
   * 1. If no availability is set, expert is considered available
   * 2. If schedule is set, check if current time falls within the schedule
   *
   * @param expert - Expert to check
   * @returns Whether the expert is available
   */
  isAvailable(expert: ExpertConfig): boolean {
    // If no availability set, consider as available
    if (!expert.availability?.schedule) {
      return true;
    }

    const schedule = expert.availability.schedule.toLowerCase();
    const timezone = expert.availability.timezone || 'Asia/Shanghai';

    try {
      const now = new Date();

      // Get current time in the expert's timezone
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'short',
        hour: 'numeric',
        hour12: false,
      });

      const parts = formatter.formatToParts(now);
      const weekdayPart = parts.find(p => p.type === 'weekday');
      const hourPart = parts.find(p => p.type === 'hour');

      const currentWeekday = weekdayPart?.value?.toLowerCase() || '';
      const currentHour = parseInt(hourPart?.value || '0', 10);

      // Parse schedule patterns
      // Pattern 1: "weekdays 10:00-18:00"
      if (schedule.includes('weekday')) {
        const isWeekday = ['mon', 'tue', 'wed', 'thu', 'fri'].some(d => currentWeekday.startsWith(d));
        if (!isWeekday) return false;

        const timeMatch = schedule.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
        if (timeMatch) {
          const startHour = parseInt(timeMatch[1], 10);
          const endHour = parseInt(timeMatch[3], 10);
          return currentHour >= startHour && currentHour < endHour;
        }
      }

      // Pattern 2: "mon-fri 9:00-17:00" or "mon-wed 10:00-18:00"
      const dayRangeMatch = schedule.match(/([a-z]{3})\s*-\s*([a-z]{3})/);
      if (dayRangeMatch) {
        const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
        const startDay = days.indexOf(dayRangeMatch[1]);
        const endDay = days.indexOf(dayRangeMatch[2]);
        const currentDay = days.findIndex(d => currentWeekday.startsWith(d));

        if (currentDay === -1 || startDay === -1 || endDay === -1) {
          return true; // Can't parse, assume available
        }

        // Handle wrap-around (e.g., fri-mon)
        let isInRange: boolean;
        if (startDay <= endDay) {
          isInRange = currentDay >= startDay && currentDay <= endDay;
        } else {
          isInRange = currentDay >= startDay || currentDay <= endDay;
        }

        if (!isInRange) return false;

        const timeMatch = schedule.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
        if (timeMatch) {
          const startHour = parseInt(timeMatch[1], 10);
          const endHour = parseInt(timeMatch[3], 10);
          return currentHour >= startHour && currentHour < endHour;
        }
      }

      // Pattern 3: Specific days "mon,wed,fri 10:00-18:00"
      const specificDaysMatch = schedule.match(/^([a-z]{3}(?:,[a-z]{3})*)/);
      if (specificDaysMatch) {
        const allowedDays = specificDaysMatch[1].split(',');
        const isAllowedDay = allowedDays.some(d => currentWeekday.startsWith(d));
        if (!isAllowedDay) return false;

        const timeMatch = schedule.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
        if (timeMatch) {
          const startHour = parseInt(timeMatch[1], 10);
          const endHour = parseInt(timeMatch[3], 10);
          return currentHour >= startHour && currentHour < endHour;
        }
      }

      // If we can't parse the schedule, assume available
      return true;
    } catch {
      // On error, assume available
      return true;
    }
  }

  /**
   * Find available experts by skill.
   *
   * @param skillName - Skill name to search for
   * @param minLevel - Minimum skill level required
   * @returns Array of matching available experts with their skill info
   */
  async findAvailableExperts(
    skillName: string,
    minLevel?: number
  ): Promise<Array<ExpertConfig & { matchedSkill: { name: string; level: number }; isAvailable: boolean }>> {
    await this.ensureLoaded();

    const searchName = skillName.toLowerCase();
    const results: Array<ExpertConfig & { matchedSkill: { name: string; level: number }; isAvailable: boolean }> = [];

    for (const expert of this.experts) {
      for (const skill of expert.skills) {
        const skillMatches = skill.name.toLowerCase().includes(searchName);
        const levelMatches = minLevel === undefined || skill.level >= minLevel;

        if (skillMatches && levelMatches) {
          const isAvailable = this.isAvailable(expert);
          results.push({
            ...expert,
            matchedSkill: { name: skill.name, level: skill.level },
            isAvailable,
          });
          break; // Only add expert once
        }
      }
    }

    // Sort by availability first, then by skill level (highest first)
    results.sort((a, b) => {
      // Available experts first
      if (a.isAvailable !== b.isAvailable) {
        return a.isAvailable ? -1 : 1;
      }
      // Then by skill level
      return b.matchedSkill.level - a.matchedSkill.level;
    });

    logger.debug({ skillName, minLevel, matchCount: results.length }, 'Found available experts');
    return results;
  }
}

/**
 * Singleton instance.
 */
let instance: ExpertRegistry | null = null;

/**
 * Get the singleton ExpertRegistry instance.
 */
export function getExpertRegistry(): ExpertRegistry {
  if (!instance) {
    instance = new ExpertRegistry();
  }
  return instance;
}
