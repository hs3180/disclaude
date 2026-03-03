/**
 * Expert Registry - Loads and manages human expert configurations.
 *
 * @see Issue #532 - Human-in-the-Loop interaction system
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { Config } from '../config/index.js';
import type {
  ExpertConfig,
  ExpertRegistryConfig,
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
